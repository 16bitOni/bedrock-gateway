"""OpenAI Chat Completions  <->  Bedrock Converse translation."""
from __future__ import annotations

import base64
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import db, media, pricing, settings
from .errors import bad_request

JSON_TOOL = "json_response"

STOP_REASON_MAP = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "model_context_window_exceeded": "length",
    "pause_turn": "length",
    "tool_use": "tool_calls",
    "guardrail_intervened": "content_filter",
    "content_filtered": "content_filter",
    "refusal": "content_filter",
    "malformed_model_output": "stop",
    "malformed_tool_use": "tool_calls",
}


# ---------------------------------------------------------------------------
# Model family helpers
# ---------------------------------------------------------------------------

def base_id(model_id: str) -> str:
    return pricing.strip_region_prefix(model_id)


def claude_version(model_id: str) -> tuple[int, int] | None:
    b = base_id(model_id)
    if not b.startswith("anthropic.claude"):
        return None
    m = re.match(r"anthropic\.claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$|:)", b)
    if m:
        return int(m.group(1)), int(m.group(2) or 0)
    m = re.match(r"anthropic\.claude-(\d+)(?:-(\d))?-", b)  # claude-3-7-sonnet, claude-3-haiku
    if m:
        return int(m.group(1)), int(m.group(2) or 0)
    return (0, 0)


def is_claude(model_id: str) -> bool:
    return claude_version(model_id) is not None


def claude_adaptive(model_id: str) -> bool:
    v = claude_version(model_id)
    return v is not None and v >= (4, 6) and "haiku" not in base_id(model_id)


def claude_no_sampling(model_id: str) -> bool:
    v = claude_version(model_id)
    return v is not None and v >= (5, 0)


def claude_supports_thinking(model_id: str) -> bool:
    v = claude_version(model_id)
    return v is not None and v >= (3, 7)


def is_nova2(model_id: str) -> bool:
    return base_id(model_id).startswith("amazon.nova-2-")


def is_gpt_oss(model_id: str) -> bool:
    return base_id(model_id).startswith("openai.")


def supports_cache_points(model_id: str) -> bool:
    b = base_id(model_id)
    v = claude_version(model_id)
    if v is not None:
        return v >= (3, 5)
    return b.startswith("amazon.nova")


def supports_forced_tool(model_id: str) -> bool:
    b = base_id(model_id)
    return is_claude(model_id) or b.startswith("amazon.nova") or b.startswith("mistral.mistral-large")


# ---------------------------------------------------------------------------
# Request conversion
# ---------------------------------------------------------------------------

@dataclass
class ConvCtx:
    model_id: str
    json_tool: str | None = None
    thinking: bool = False
    include_usage: bool = False
    tool_names: list[str] = field(default_factory=list)


def _text_of(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if isinstance(p, dict) and p.get("type") in ("text", "input_text") and p.get("text"):
                out.append(p["text"])
            elif isinstance(p, str):
                out.append(p)
        return "\n".join(out)
    return str(content)


def _convert_parts(content: Any) -> list[dict]:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"text": content}] if content.strip() else []
    blocks: list[dict] = []
    for p in content:
        if isinstance(p, str):
            if p.strip():
                blocks.append({"text": p})
            continue
        t = p.get("type")
        if t in ("text", "input_text"):
            if (p.get("text") or "").strip():
                blocks.append({"text": p["text"]})
        elif t in ("image_url", "input_image"):
            iu = p.get("image_url")
            url = iu.get("url") if isinstance(iu, dict) else iu
            if not url:
                raise bad_request("image_url part without url.")
            mime, data = media.load_any(url)
            fmt = media.IMAGE_FORMATS.get(mime) or media.sniff_image_format(data)
            if not fmt:
                raise bad_request(f"Unsupported image type `{mime}` (use png, jpeg, gif or webp).")
            blocks.append({"image": {"format": fmt, "source": {"bytes": data}}})
        elif t == "input_audio":
            a = p.get("input_audio") or {}
            fmt = (a.get("format") or "wav").lower()
            if fmt not in media.AUDIO_FORMATS:
                raise bad_request(f"Unsupported audio format `{fmt}`.")
            blocks.append({"audio": {"format": fmt, "source": {"bytes": base64.b64decode(a.get("data") or "")}}})
        elif t in ("file", "input_file"):
            f = p.get("file") or p
            data_uri = f.get("file_data") or f.get("url")
            if not data_uri:
                raise bad_request("file part needs `file_data` (data URI). Uploaded file ids are not supported.")
            mime, data = media.load_any(data_uri) if data_uri.startswith(("data:", "http")) else \
                ("application/pdf", base64.b64decode(data_uri))
            name = f.get("filename") or "document"
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            fmt = media.DOC_FORMATS.get(mime) or (ext if ext in media.DOC_FORMATS.values() else None)
            if mime.startswith("image/"):
                blocks.append({"image": {"format": media.IMAGE_FORMATS.get(mime, "png"), "source": {"bytes": data}}})
                continue
            if not fmt:
                raise bad_request(f"Unsupported document type `{mime}`.")
            blocks.append({"document": {"format": fmt, "name": media.safe_doc_name(name), "source": {"bytes": data}}})
        elif t == "refusal":
            if p.get("refusal"):
                blocks.append({"text": p["refusal"]})
        else:
            raise bad_request(f"Unsupported content part type `{t}`.")
    return blocks


def _stash_lookup(tool_call_ids: list[str]) -> list[dict] | None:
    for tid in tool_call_ids:
        r = db.one("SELECT blocks FROM reasoning_stash WHERE tool_call_id = ?", (tid,))
        if r:
            blocks = db.jload(r["blocks"], [])
            for b in blocks:
                rc = b.get("reasoningContent", {})
                if "redactedContent" in rc and isinstance(rc["redactedContent"], str):
                    rc["redactedContent"] = base64.b64decode(rc["redactedContent"])
            return blocks
    return None


def stash_reasoning(tool_call_ids: list[str], blocks: list[dict]) -> None:
    if not tool_call_ids or not blocks:
        return
    serial = []
    for b in blocks:
        rc = dict(b.get("reasoningContent", {}))
        if isinstance(rc.get("redactedContent"), (bytes, bytearray)):
            rc["redactedContent"] = base64.b64encode(rc["redactedContent"]).decode()
        serial.append({"reasoningContent": rc})
    now = time.time()
    db.executemany("INSERT OR REPLACE INTO reasoning_stash(tool_call_id, blocks, created_at) VALUES(?,?,?)",
                   [(tid, db.jdump(serial), now) for tid in tool_call_ids])


def convert_messages(messages: list[dict]) -> tuple[list[dict], list[dict], list[list[str]]]:
    """Returns (system_blocks, converse_messages, tool_call_ids_per_message)."""
    system: list[dict] = []
    out: list[dict] = []
    call_ids: list[list[str]] = []

    def push(role: str, blocks: list[dict], ids: list[str] | None = None):
        if not blocks:
            return
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
            call_ids[-1].extend(ids or [])
        else:
            out.append({"role": role, "content": blocks})
            call_ids.append(list(ids or []))

    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            raise bad_request(f"messages[{i}] must be an object.", param="messages")
        role = m.get("role")
        if role in ("system", "developer"):
            t = _text_of(m.get("content"))
            if t.strip():
                system.append({"text": t})
        elif role == "user":
            blocks = _convert_parts(m.get("content"))
            if any("document" in b for b in blocks) and not any("text" in b for b in blocks):
                blocks.append({"text": "See the attached document."})
            push("user", blocks)
        elif role == "assistant":
            blocks = _convert_parts(m.get("content"))
            if m.get("refusal") and not blocks:
                blocks = [{"text": m["refusal"]}]
            ids = []
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                args = fn.get("arguments") or "{}"
                try:
                    parsed = json.loads(args) if isinstance(args, str) else args
                except ValueError:
                    parsed = {"_raw_arguments": args}
                if not isinstance(parsed, dict):
                    parsed = {"value": parsed}
                tid = tc.get("id") or ("call_" + uuid.uuid4().hex[:20])
                ids.append(tid)
                blocks.append({"toolUse": {"toolUseId": tid, "name": fn.get("name") or "tool", "input": parsed}})
            if m.get("function_call"):  # legacy
                fc = m["function_call"]
                tid = "call_" + uuid.uuid4().hex[:20]
                blocks.append({"toolUse": {"toolUseId": tid, "name": fc.get("name", "tool"),
                                           "input": json.loads(fc.get("arguments") or "{}")}})
            push("assistant", blocks, ids)
        elif role == "tool":
            content = m.get("content")
            text = _text_of(content) if not isinstance(content, str) else content
            result_content: list[dict] = []
            if isinstance(content, list):
                for p in content:
                    if isinstance(p, dict) and p.get("type") == "image_url":
                        result_content.extend(_convert_parts([p]))
            result_content.insert(0, {"text": text if text.strip() else "(empty)"})
            push("user", [{"toolResult": {"toolUseId": m.get("tool_call_id") or "unknown",
                                          "content": result_content}}])
        elif role == "function":  # legacy function result
            push("user", [{"text": f"Function `{m.get('name')}` returned: {_text_of(m.get('content'))}"}])
        else:
            raise bad_request(f"Unsupported role `{role}` in messages[{i}].", param="messages")

    if not out:
        raise bad_request("`messages` must contain at least one user message.", param="messages")
    if out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": [{"text": "(conversation start)"}]})
        call_ids.insert(0, [])
    # toolResult blocks must come before other blocks in a user turn
    for msg in out:
        if msg["role"] == "user" and any("toolResult" in b for b in msg["content"]):
            msg["content"].sort(key=lambda b: 0 if "toolResult" in b else 1)
    return system, out, call_ids


def _effort(body: dict) -> str | None:
    e = body.get("reasoning_effort")
    r = body.get("reasoning")
    if e is None and isinstance(r, dict):
        e = r.get("effort")
        if e is None and r.get("max_tokens"):
            e = "high"
        if e is None and r.get("enabled"):
            e = "medium"
    return e.lower() if isinstance(e, str) else None


def build_converse_request(body: dict, model_id: str, preset: dict | None = None,
                           key: dict | None = None) -> tuple[dict, ConvCtx]:
    body = dict(body)
    if preset:
        params = preset.get("params") or {}
        for k, v in params.items():
            body.setdefault(k, v)
        if preset.get("system_prompt"):
            msgs = list(body.get("messages") or [])
            body["messages"] = [{"role": "system", "content": preset["system_prompt"]}] + msgs

    if (body.get("n") or 1) > 1:
        raise bad_request("`n` > 1 is not supported by Bedrock. Send parallel requests instead.", param="n")

    system, messages, call_ids = convert_messages(body.get("messages") or [])
    ctx = ConvCtx(model_id=model_id)
    so = body.get("stream_options") or {}
    ctx.include_usage = bool(so.get("include_usage"))

    inference: dict[str, Any] = {}
    additional: dict[str, Any] = {}
    max_tokens = body.get("max_completion_tokens") or body.get("max_tokens")

    temperature = body.get("temperature")
    top_p = body.get("top_p")
    stop = body.get("stop")
    if isinstance(stop, str):
        stop = [stop]
    stop = [s for s in (stop or []) if isinstance(s, str) and s]

    # ---- tools ----
    tools_in = body.get("tools") or []
    if not tools_in and body.get("functions"):  # legacy
        tools_in = [{"type": "function", "function": f} for f in body["functions"]]
    tool_specs: list[dict] = []
    for t in tools_in:
        if t.get("type", "function") != "function":
            continue
        fn = t.get("function") or {}
        if not fn.get("name"):
            raise bad_request("Every tool needs function.name.", param="tools")
        spec = {"name": fn["name"], "inputSchema": {"json": fn.get("parameters") or {"type": "object", "properties": {}}}}
        if fn.get("description"):
            spec["description"] = fn["description"]
        tool_specs.append({"toolSpec": spec})
        ctx.tool_names.append(fn["name"])

    tool_choice_in = body.get("tool_choice", body.get("function_call"))
    tool_choice: dict | None = None
    if isinstance(tool_choice_in, str):
        if tool_choice_in == "required":
            tool_choice = {"any": {}}
        elif tool_choice_in == "auto":
            tool_choice = {"auto": {}}
        elif tool_choice_in == "none":
            tool_choice = None
            if tool_specs and not any("toolUse" in b for m in messages for b in m["content"]):
                tool_specs = []  # nothing references tools: just drop them
    elif isinstance(tool_choice_in, dict):
        name = (tool_choice_in.get("function") or {}).get("name") or tool_choice_in.get("name")
        if name:
            tool_choice = {"tool": {"name": name}}

    # ---- response_format ----
    rf = body.get("response_format") or {}
    rf_type = rf.get("type") if isinstance(rf, dict) else None
    if rf_type == "json_schema":
        js = rf.get("json_schema") or {}
        schema = js.get("schema") or {"type": "object"}
        if tool_specs:
            system.append({"text": "Your final answer must be a JSON object matching this JSON Schema:\n"
                                   + json.dumps(schema)})
        else:
            ctx.json_tool = JSON_TOOL
            desc = js.get("description") or f"Return the final answer as `{js.get('name') or 'response'}`."
            tool_specs = [{"toolSpec": {"name": JSON_TOOL, "description": desc, "inputSchema": {"json": schema}}}]
            if supports_forced_tool(model_id):
                tool_choice = {"tool": {"name": JSON_TOOL}}
            else:
                tool_choice = {"auto": {}}
                system.append({"text": f"Always answer by calling the `{JSON_TOOL}` tool exactly once."})
    elif rf_type == "json_object":
        system.append({"text": "Respond only with a single valid JSON object. No prose, no code fences."})

    # ---- reasoning / thinking ----
    effort = _effort(body)
    thinking_active = False
    if is_claude(model_id):
        last_tool_turn = None
        for idx in range(len(messages) - 1, -1, -1):
            if messages[idx]["role"] == "assistant":
                if any("toolUse" in b for b in messages[idx]["content"]):
                    last_tool_turn = idx
                break
        stashed = _stash_lookup(call_ids[last_tool_turn]) if last_tool_turn is not None else None

        if claude_adaptive(model_id):
            if effort == "none" or ctx.json_tool:
                additional["thinking"] = {"type": "disabled"}
            elif effort:
                additional["thinking"] = {"type": "adaptive", "display": "summarized"}
                additional["output_config"] = {"effort": {"minimal": "low"}.get(effort, effort)}
                thinking_active = True
            elif claude_no_sampling(model_id):
                if tool_choice and ("any" in tool_choice or "tool" in tool_choice):
                    # Forced tool use is incompatible with thinking; the client asked for a tool, honour it.
                    additional["thinking"] = {"type": "disabled"}
                else:
                    # Claude 5+: adaptive thinking is on by default. Make it visible.
                    additional["thinking"] = {"type": "adaptive", "display": "summarized"}
                    thinking_active = True
        elif effort and effort != "none" and claude_supports_thinking(model_id) and not ctx.json_tool:
            budget = {"minimal": 1024, "low": 2048, "medium": 8192, "high": 16384, "xhigh": 32000,
                      "max": 32000}.get(effort, 4096)
            v = claude_version(model_id) or (0, 0)
            max_out = 32000 if v in ((4, 0), (4, 1)) else 64000
            budget = min(budget, max_out - 2048)
            additional["thinking"] = {"type": "enabled", "budget_tokens": budget}
            if not max_tokens or int(max_tokens) <= budget:
                max_tokens = budget + int(max_tokens or settings.get("default_max_tokens") or 4096)
            max_tokens = min(int(max_tokens), max_out)
            thinking_active = True

        if thinking_active and last_tool_turn is not None:
            if stashed:
                messages[last_tool_turn]["content"] = stashed + [
                    b for b in messages[last_tool_turn]["content"] if "reasoningContent" not in b]
                # earlier assistant turns may also have stashed reasoning; harmless to include
            else:
                # Tool loop without the thinking signature (e.g. history from another client):
                # Claude rejects that, so turn thinking off for this request.
                additional["thinking"] = {"type": "disabled"} if claude_adaptive(model_id) else None
                if additional.get("thinking") is None:
                    additional.pop("thinking", None)
                additional.pop("output_config", None)
                thinking_active = False

        if thinking_active or claude_no_sampling(model_id):
            temperature = None
            top_p = None
            if thinking_active and tool_choice and ("any" in tool_choice or "tool" in tool_choice):
                tool_choice = {"auto": {}}
        if temperature is not None and top_p is not None and claude_version(model_id) >= (4, 5):
            top_p = None  # newer Claude models reject both at once
    elif is_nova2(model_id) and effort and effort != "none":
        lvl = {"minimal": "low", "xhigh": "high", "max": "high"}.get(effort, effort)
        additional["reasoningConfig"] = {"type": "enabled", "maxReasoningEffort": lvl}
        temperature = None
        top_p = None
        if lvl == "high":
            max_tokens = None
        thinking_active = True
    elif is_gpt_oss(model_id) and effort and effort != "none":
        additional["reasoning_effort"] = {"minimal": "low", "xhigh": "high", "max": "high"}.get(effort, effort)
        thinking_active = True
    ctx.thinking = thinking_active

    if max_tokens is None and not (is_nova2(model_id) and additional.get("reasoningConfig", {}).get(
            "maxReasoningEffort") == "high"):
        max_tokens = int(settings.get("default_max_tokens") or 4096)
        if thinking_active and is_claude(model_id):
            max_tokens = max(max_tokens, 16000)
    if max_tokens is not None:
        inference["maxTokens"] = int(max_tokens)
    if temperature is not None:
        inference["temperature"] = float(temperature)
    if top_p is not None:
        inference["topP"] = float(top_p)
    if stop:
        inference["stopSequences"] = list(stop)[:4] if not is_claude(model_id) else list(stop)

    # ---- automatic prompt caching ----
    if settings.get("auto_prompt_cache") and supports_cache_points(model_id):
        sys_chars = sum(len(b.get("text", "")) for b in system)
        if sys_chars > 4400:
            system.append({"cachePoint": {"type": "default"}})
        if tool_specs and is_claude(model_id) and len(json.dumps(tool_specs)) > 4400:
            tool_specs.append({"cachePoint": {"type": "default"}})
        conv_chars = sum(len(json.dumps(b, default=lambda o: "x" * min(len(o), 4000)))
                         for m in messages for b in m["content"])
        if conv_chars > 12000 and messages[-1]["role"] == "user" and is_claude(model_id):
            messages[-1]["content"].append({"cachePoint": {"type": "default"}})

    req: dict[str, Any] = {"modelId": model_id, "messages": messages}
    if system:
        req["system"] = system
    if inference:
        req["inferenceConfig"] = inference
    if tool_specs:
        tc: dict[str, Any] = {"tools": tool_specs}
        if tool_choice:
            tc["toolChoice"] = tool_choice
        req["toolConfig"] = tc
    elif any("toolUse" in b or "toolResult" in b for m in messages for b in m["content"]):
        # History contains tool calls but no tools were sent: Bedrock requires a toolConfig.
        names = {b["toolUse"]["name"] for m in messages for b in m["content"] if "toolUse" in b}
        req["toolConfig"] = {"tools": [{"toolSpec": {"name": n, "description": n, "inputSchema": {
            "json": {"type": "object", "properties": {}}}}} for n in sorted(names)]}

    extra = body.get("additional_model_request_fields") or body.get("additionalModelRequestFields")
    if isinstance(extra, dict):
        additional.update(extra)
    if body.get("top_k") is not None and (is_claude(model_id)) and not thinking_active:
        additional["top_k"] = body["top_k"]
    additional = {k: v for k, v in additional.items() if v is not None}
    if additional:
        req["additionalModelRequestFields"] = additional

    if key and key.get("guardrail_id"):
        req["guardrailConfig"] = {"guardrailIdentifier": key["guardrail_id"],
                                  "guardrailVersion": key.get("guardrail_version") or "DRAFT"}
    if body.get("service_tier") in ("priority", "flex"):
        req["serviceTier"] = {"type": body["service_tier"]}
    if body.get("latency") == "optimized":
        req["performanceConfig"] = {"latency": "optimized"}
    return req, ctx


# ---------------------------------------------------------------------------
# Response conversion
# ---------------------------------------------------------------------------

def usage_from_bedrock(u: dict | None) -> pricing.Usage:
    u = u or {}
    return pricing.Usage(
        input_tokens=int(u.get("inputTokens") or 0),
        output_tokens=int(u.get("outputTokens") or 0),
        cache_read_tokens=int(u.get("cacheReadInputTokens") or 0),
        cache_write_tokens=int(u.get("cacheWriteInputTokens") or 0),
    )


def openai_usage(u: pricing.Usage, cost: float | None = None) -> dict:
    prompt = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens
    out = {
        "prompt_tokens": prompt,
        "completion_tokens": u.output_tokens,
        "total_tokens": prompt + u.output_tokens,
        "prompt_tokens_details": {"cached_tokens": u.cache_read_tokens, "cache_write_tokens": u.cache_write_tokens},
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    if cost is not None:
        out["cost"] = round(cost, 8)
    return out


def new_completion_id() -> str:
    return "chatcmpl-" + uuid.uuid4().hex[:24]


def converse_to_openai(resp: dict, model_name: str, ctx: ConvCtx, completion_id: str) -> tuple[dict, pricing.Usage]:
    content = ((resp.get("output") or {}).get("message") or {}).get("content") or []
    texts: list[str] = []
    reasoning_texts: list[str] = []
    reasoning_blocks: list[dict] = []
    tool_calls: list[dict] = []
    json_out: str | None = None
    for b in content:
        if "text" in b:
            texts.append(b["text"])
        elif "reasoningContent" in b:
            reasoning_blocks.append({"reasoningContent": b["reasoningContent"]})
            rt = (b["reasoningContent"].get("reasoningText") or {}).get("text")
            if rt:
                reasoning_texts.append(rt)
        elif "toolUse" in b:
            tu = b["toolUse"]
            if ctx.json_tool and tu.get("name") == ctx.json_tool:
                json_out = json.dumps(tu.get("input"), ensure_ascii=False)
                continue
            tool_calls.append({
                "id": tu.get("toolUseId"),
                "type": "function",
                "function": {"name": tu.get("name"), "arguments": json.dumps(tu.get("input") or {}, ensure_ascii=False)},
            })

    finish = STOP_REASON_MAP.get(resp.get("stopReason") or "end_turn", "stop")
    if json_out is not None:
        text = json_out
        finish = "stop" if finish in ("tool_calls", "stop") else finish
    else:
        text = "".join(texts)
    if tool_calls:
        finish = "tool_calls"
        if ctx.thinking and reasoning_blocks:
            stash_reasoning([tc["id"] for tc in tool_calls], reasoning_blocks)

    message: dict[str, Any] = {"role": "assistant", "content": text if (text or not tool_calls) else None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    if reasoning_texts:
        message["reasoning_content"] = "\n".join(reasoning_texts)
    message["refusal"] = None

    usage = usage_from_bedrock(resp.get("usage"))
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [{"index": 0, "message": message, "logprobs": None, "finish_reason": finish}],
        "usage": openai_usage(usage),
        "system_fingerprint": None,
    }, usage


class StreamTranslator:
    """Turns ConverseStream events into OpenAI chat.completion.chunk dicts."""

    def __init__(self, model_name: str, ctx: ConvCtx, completion_id: str):
        self.model_name = model_name
        self.ctx = ctx
        self.id = completion_id
        self.created = int(time.time())
        self.tool_index: dict[int, int] = {}
        self.tool_ids: list[str] = []
        self.json_blocks: set[int] = set()
        self.reasoning: dict[int, dict] = {}
        self.usage = pricing.Usage()
        self.finish_reason: str | None = None
        self.text_parts: list[str] = []
        self.reasoning_parts: list[str] = []
        self.tool_calls: dict[int, dict] = {}
        self.started = False

    def _chunk(self, delta: dict, finish: str | None = None) -> dict:
        return {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model_name,
                "system_fingerprint": None,
                "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]}

    def start_chunk(self) -> dict:
        self.started = True
        return self._chunk({"role": "assistant", "content": ""})

    def feed(self, event: dict) -> list[dict]:
        out: list[dict] = []
        if "messageStart" in event:
            if not self.started:
                out.append(self.start_chunk())
        elif "contentBlockStart" in event:
            ev = event["contentBlockStart"]
            idx = ev.get("contentBlockIndex", 0)
            tu = (ev.get("start") or {}).get("toolUse")
            if tu:
                if self.ctx.json_tool and tu.get("name") == self.ctx.json_tool:
                    self.json_blocks.add(idx)
                else:
                    ti = len(self.tool_index)
                    self.tool_index[idx] = ti
                    self.tool_ids.append(tu.get("toolUseId"))
                    self.tool_calls[ti] = {"id": tu.get("toolUseId"), "type": "function",
                                           "function": {"name": tu.get("name"), "arguments": ""}}
                    out.append(self._chunk({"tool_calls": [{
                        "index": ti, "id": tu.get("toolUseId"), "type": "function",
                        "function": {"name": tu.get("name"), "arguments": ""}}]}))
        elif "contentBlockDelta" in event:
            ev = event["contentBlockDelta"]
            idx = ev.get("contentBlockIndex", 0)
            d = ev.get("delta") or {}
            if "text" in d:
                if d["text"]:
                    self.text_parts.append(d["text"])
                    out.append(self._chunk({"content": d["text"]}))
            elif "toolUse" in d:
                piece = (d["toolUse"] or {}).get("input") or ""
                if idx in self.json_blocks:
                    if piece:
                        self.text_parts.append(piece)
                        out.append(self._chunk({"content": piece}))
                elif idx in self.tool_index:
                    ti = self.tool_index[idx]
                    self.tool_calls[ti]["function"]["arguments"] += piece
                    if piece:
                        out.append(self._chunk({"tool_calls": [{"index": ti, "function": {"arguments": piece}}]}))
            elif "reasoningContent" in d:
                rc = d["reasoningContent"]
                slot = self.reasoning.setdefault(idx, {"text": "", "signature": None, "redacted": None})
                if rc.get("text"):
                    slot["text"] += rc["text"]
                    self.reasoning_parts.append(rc["text"])
                    out.append(self._chunk({"reasoning_content": rc["text"]}))
                if rc.get("signature"):
                    slot["signature"] = rc["signature"]
                if rc.get("redactedContent"):
                    slot["redacted"] = rc["redactedContent"]
        elif "messageStop" in event:
            reason = event["messageStop"].get("stopReason") or "end_turn"
            finish = STOP_REASON_MAP.get(reason, "stop")
            if self.json_blocks and finish == "tool_calls" and not self.tool_index:
                finish = "stop"
            if self.tool_index:
                finish = "tool_calls"
            self.finish_reason = finish
            out.append(self._chunk({}, finish))
            if self.tool_ids and self.ctx.thinking:
                stash_reasoning(self.tool_ids, self.reasoning_blocks())
        elif "metadata" in event:
            self.usage = usage_from_bedrock(event["metadata"].get("usage"))
        return out

    def reasoning_blocks(self) -> list[dict]:
        blocks = []
        for idx in sorted(self.reasoning):
            s = self.reasoning[idx]
            if s["redacted"]:
                blocks.append({"reasoningContent": {"redactedContent": s["redacted"]}})
            else:
                rt: dict[str, Any] = {"text": s["text"]}
                if s["signature"]:
                    rt["signature"] = s["signature"]
                blocks.append({"reasoningContent": {"reasoningText": rt}})
        return blocks

    def usage_chunk(self, cost: float | None) -> dict:
        return {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model_name,
                "choices": [], "usage": openai_usage(self.usage, cost)}

    def final_message(self) -> dict:
        """Assembled response (for logging)."""
        msg: dict[str, Any] = {"role": "assistant", "content": "".join(self.text_parts) or None}
        if self.tool_calls:
            msg["tool_calls"] = [self.tool_calls[i] for i in sorted(self.tool_calls)]
        if self.reasoning_parts:
            msg["reasoning_content"] = "".join(self.reasoning_parts)
        return {"choices": [{"index": 0, "message": msg, "finish_reason": self.finish_reason}]}
