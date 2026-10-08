"""Anthropic Messages API (/v1/messages) on Bedrock — lets Claude Code and the Anthropic SDK
use the portal with ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN."""
from __future__ import annotations

import json
import re
from typing import Iterator

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

from .. import aws, catalog, pricing, settings, translate, usage
from ..auth import authenticate
from ..errors import GatewayError, from_aws
from .common import SSE_HEADERS, gateway_headers, read_json, run_with_fallback, session_id, sse_event

router = APIRouter()
_EXTRANEOUS = re.compile(r"extraneous key \[([\w.-]+)\]")

# Beta flags Bedrock accepts for Claude (others, e.g. Claude Code's direct-API flags, are rejected).
# Extend via Settings → Gateway → "Anthropic betas" if AWS adds more.
DEFAULT_BEDROCK_BETAS = [
    "context-1m-2025-08-07", "interleaved-thinking-2025-05-14", "output-128k-2025-02-19",
    "context-management-2025-06-27", "token-efficient-tools-2025-02-19", "computer-use-2025-01-24",
    "computer-use-2025-11-24", "tool-search-tool-2025-10-19", "effort-2025-11-24",
    "tool-examples-2025-10-29", "dev-full-thinking-2025-05-14",
]


def _prepare(body: dict, request: Request) -> dict:
    b = {k: v for k, v in body.items() if k not in ("model", "stream")}
    b["anthropic_version"] = "bedrock-2023-05-31"
    allowed = set(settings.get("anthropic_betas") or DEFAULT_BEDROCK_BETAS)
    betas = [x.strip() for x in (request.headers.get("anthropic-beta") or "").split(",")
             if x.strip() and x.strip() in allowed]
    if betas:
        b["anthropic_beta"] = betas
    return b


def _invoke(model_id: str, payload: dict, stream: bool, key: dict):
    """Invoke with self-healing: drop keys/betas Bedrock rejects and retry."""
    client = aws.client("bedrock-runtime")
    payload = dict(payload)
    for _ in range(6):
        kwargs = dict(modelId=model_id, body=json.dumps(payload), contentType="application/json",
                      accept="application/json")
        if key.get("guardrail_id"):
            kwargs["guardrailIdentifier"] = key["guardrail_id"]
            kwargs["guardrailVersion"] = key.get("guardrail_version") or "DRAFT"
        try:
            if stream:
                return client.invoke_model_with_response_stream(**kwargs)
            return client.invoke_model(**kwargs)
        except Exception as e:  # noqa: BLE001
            if aws.error_code(e) != "ValidationException":
                raise
            msg = aws.error_message(e)
            m = _EXTRANEOUS.search(msg)
            if m and m.group(1) in payload:
                payload.pop(m.group(1))
                continue
            if "beta" in msg.lower() and payload.get("anthropic_beta"):
                bad = [b for b in payload["anthropic_beta"] if b in msg]
                if bad:
                    payload["anthropic_beta"] = [b for b in payload["anthropic_beta"] if b not in bad]
                else:
                    payload.pop("anthropic_beta")
                if not payload.get("anthropic_beta"):
                    payload.pop("anthropic_beta", None)
                continue
            raise
    raise GatewayError(400, "Request rejected by Bedrock after removing unsupported fields.")


def _usage(u: dict, into: pricing.Usage) -> None:
    if not u:
        return
    if u.get("input_tokens") is not None:
        into.input_tokens = int(u["input_tokens"])
    if u.get("output_tokens") is not None:
        into.output_tokens = int(u["output_tokens"])
    if u.get("cache_read_input_tokens") is not None:
        into.cache_read_tokens = int(u["cache_read_input_tokens"])
    if u.get("cache_creation_input_tokens") is not None:
        into.cache_write_tokens = int(u["cache_creation_input_tokens"])


def _anthropic_error(e: GatewayError) -> JSONResponse:
    return JSONResponse(e.anthropic_body(), status_code=e.status, headers=e.headers)


@router.post("/v1/messages")
@router.post("/anthropic/v1/messages", include_in_schema=False)
async def messages(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    stream = bool(body.get("stream"))
    log = usage.RequestLog(endpoint="messages", key=key, requested_model=body.get("model"), stream=stream,
                           session_id=session_id(request))
    log.request_body = body
    try:
        resolved = catalog.resolve(body.get("model") or "", key, kind="chat")
        for t in resolved.targets:
            if not translate.is_claude(t):
                raise GatewayError(400, f"/v1/messages only serves Claude models; `{t}` is not Claude. "
                                   "Use /v1/chat/completions for other models.", param="model")
        payload = _prepare(body, request)
        if resolved.preset and resolved.preset.get("system_prompt") and "system" not in payload:
            payload["system"] = resolved.preset["system_prompt"]
        if stream:
            return await run_in_threadpool(_stream, body, payload, resolved, key, log)
        return await run_in_threadpool(_complete, body, payload, resolved, key, log)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        return _anthropic_error(e)


def _complete(body, payload, resolved, key, log):
    model_used, resp = run_with_fallback(resolved, log, lambda m: _invoke(m, payload, False, key))
    data = json.loads(resp["body"].read())
    data["model"] = body.get("model") or model_used
    _usage(data.get("usage") or {}, log.usage)
    log.finish_reason = data.get("stop_reason")
    cost = log.compute_cost()
    log.response_body = data
    log.finish(200)
    return JSONResponse(data, headers=gateway_headers(log, {"x-portal-cost-usd": f"{cost:.8f}"}))


def _stream(body, payload, resolved, key, log):
    model_used, resp = run_with_fallback(resolved, log, lambda m: _invoke(m, payload, True, key))
    text_parts: list[str] = []

    def gen() -> Iterator[str]:
        status, code, msg = 200, None, None
        try:
            for event in resp["body"]:
                if "chunk" in event:
                    data = json.loads(event["chunk"]["bytes"])
                    data.pop("amazon-bedrock-invocationMetrics", None)
                    t = data.get("type", "message")
                    if t == "message_start":
                        msg_obj = data.get("message") or {}
                        msg_obj["model"] = body.get("model") or model_used
                        _usage(msg_obj.get("usage") or {}, log.usage)
                    elif t == "message_delta":
                        _usage(data.get("usage") or {}, log.usage)
                        log.finish_reason = (data.get("delta") or {}).get("stop_reason")
                    elif t == "content_block_delta":
                        log.mark_first_token()
                        d = data.get("delta") or {}
                        if d.get("type") == "text_delta":
                            text_parts.append(d.get("text", ""))
                    yield sse_event(t, data)
                else:
                    name = next(iter(event.keys()), "error")
                    info = event.get(name) or {}
                    raise GatewayError(429 if "throttl" in name.lower() else 529 if "unavailable" in name.lower() else 500,
                                       f"Bedrock stream error ({name}): {info.get('message') or info}",
                                       type="api_error", code=name)
        except GeneratorExit:
            status, code, msg = 499, "client_disconnected", "Client closed the stream"
            try:
                resp["body"].close()
            except Exception:  # noqa: BLE001
                pass
            if not log.usage.output_tokens:
                log.usage.output_tokens = sum(len(p) for p in text_parts) // 4
            raise
        except GatewayError as e:
            status, code, msg = e.status, e.code, e.message
            yield sse_event("error", e.anthropic_body())
        except Exception as e:  # noqa: BLE001
            ge = from_aws(e, model_used)
            status, code, msg = ge.status, ge.code, ge.message
            yield sse_event("error", ge.anthropic_body())
        finally:
            log.response_body = {"text": "".join(text_parts)[:50000], "stop_reason": log.finish_reason}
            log.finish(status, code, msg)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={**SSE_HEADERS, **gateway_headers(log)})


@router.post("/v1/messages/count_tokens")
@router.post("/anthropic/v1/messages/count_tokens", include_in_schema=False)
async def count_tokens(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    try:
        resolved = catalog.resolve(body.get("model") or "", key, kind="chat")
    except GatewayError as e:
        return _anthropic_error(e)
    payload = _prepare(body, request)
    payload.setdefault("max_tokens", 1)
    payload.pop("anthropic_beta", None)

    def run():
        base = translate.base_id(resolved.primary)
        try:
            r = aws.client("bedrock-runtime").count_tokens(
                modelId=base, input={"invokeModel": {"body": json.dumps(payload).encode()}})
            return {"input_tokens": int(r.get("inputTokens") or 0)}
        except Exception:  # noqa: BLE001 - fall back to an estimate
            chars = len(json.dumps({k: payload.get(k) for k in ("system", "messages", "tools")}))
            return {"input_tokens": max(1, chars // 4), "estimated": True}

    return await run_in_threadpool(run)
