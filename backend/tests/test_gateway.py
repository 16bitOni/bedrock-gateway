from __future__ import annotations

import json

import anthropic
import openai
import pytest

from app import db, usage
from conftest import FakeClientError, make_key


def oai(client, key):
    return openai.OpenAI(base_url="http://testserver/v1", api_key=key, http_client=client, max_retries=0)


def logs(client):
    usage.flush()
    return client.get("/api/logs").json()["data"]


def test_catalog_sync_and_aliases(env):
    client, fake, _ = env
    models = {m["id"]: m for m in client.get("/api/models").json()["data"]}
    assert models["global.anthropic.claude-opus-5-5"]["enabled"] == 1
    assert models["us.anthropic.claude-opus-5-5"]["enabled"] == 0          # one preferred route per model
    assert models["openai.gpt-oss-120b-1:0"]["route"] == "on_demand"
    assert models["amazon.nova-2-sonic-v1:0"]["kind"] == "realtime"
    assert models["amazon.nova-2-sonic-v1:0"]["enabled"] == 0
    aliases = {a["name"]: a["targets"] for a in client.get("/api/aliases").json()["data"]}
    assert aliases["smart"][0] == "global.anthropic.claude-opus-5-5"
    assert aliases["fast"][0] == "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert aliases["embed"] == ["amazon.titan-embed-text-v2:0"]
    assert aliases["image"] == ["amazon.nova-canvas-v1:0"]
    assert aliases["whisper-1"] == ["mistral.voxtral-mini-3b-2507"]


def test_chat_non_stream_with_sdk(env):
    client, fake, _ = env
    key = make_key(client)
    r = oai(client, key).chat.completions.with_raw_response.create(
        model="smart", messages=[{"role": "developer", "content": "be brief"}, {"role": "user", "content": "hi"}],
        temperature=0.3, max_completion_tokens=100)
    resp = r.parse()
    assert resp.choices[0].message.content == "Hello from Bedrock"
    assert resp.choices[0].message.reasoning_content == "thinking..."  # type: ignore[attr-defined]
    assert resp.usage.prompt_tokens == 3000 and resp.usage.completion_tokens == 500
    assert resp.usage.prompt_tokens_details.cached_tokens == 2000
    # Opus 5.5 global: 1000*4 + 500*20 + 2000*0.2 per 1M
    assert resp.usage.cost == pytest.approx((1000 * 4 + 500 * 20 + 2000 * 0.2) / 1e6)  # type: ignore[attr-defined]
    assert r.headers["x-portal-model"] == "global.anthropic.claude-opus-5-5"
    req = fake.runtime.calls[-1][1]
    assert req["system"] == [{"text": "be brief"}]
    assert "temperature" not in req.get("inferenceConfig", {})          # Claude 5: sampling params stripped
    assert req["additionalModelRequestFields"]["thinking"]["type"] == "adaptive"
    row = logs(client)[0]
    assert row["status"] == 200 and row["cost_usd"] > 0 and row["key_name"] == "test-key"


def test_stream_with_tool_calls_and_reasoning_stash(env):
    client, fake, _ = env
    key = make_key(client)
    fake.runtime.next_stream = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "need weather"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "SIG123"}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "tooluse_1", "name": "get_weather"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": "{\"city\": "}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": "\"Kolkata\"}"}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
        {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 30, "totalTokens": 130}}},
    ]
    tools = [{"type": "function", "function": {"name": "get_weather", "description": "Weather",
                                                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
    stream = oai(client, key).chat.completions.create(
        model="claude-sonnet", messages=[{"role": "user", "content": "weather in Kolkata?"}], tools=tools,
        stream=True, stream_options={"include_usage": True})
    args, name, tid, finish, usage_chunk, reasoning = "", None, None, None, None, ""
    for chunk in stream:
        if chunk.usage:
            usage_chunk = chunk.usage
        for ch in chunk.choices:
            if getattr(ch.delta, "reasoning_content", None):
                reasoning += ch.delta.reasoning_content
            for tc in ch.delta.tool_calls or []:
                assert tc.index == 0
                if tc.id:
                    tid, name = tc.id, tc.function.name
                args += tc.function.arguments or ""
            finish = ch.finish_reason or finish
    assert name == "get_weather" and tid == "tooluse_1" and json.loads(args) == {"city": "Kolkata"}
    assert finish == "tool_calls" and reasoning == "need weather"
    assert usage_chunk.prompt_tokens == 100 and usage_chunk.cost > 0  # type: ignore[attr-defined]

    # Follow-up turn: the gateway must re-insert the signed reasoning block before the tool call.
    oai(client, key).chat.completions.create(model="claude-sonnet", tools=tools, messages=[
        {"role": "user", "content": "weather in Kolkata?"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "tooluse_1", "type": "function", "function": {"name": "get_weather", "arguments": args}}]},
        {"role": "tool", "tool_call_id": "tooluse_1", "content": "31C sunny"}])
    req = fake.runtime.calls[-1][1]
    assistant = req["messages"][1]["content"]
    assert assistant[0]["reasoningContent"]["reasoningText"] == {"text": "need weather", "signature": "SIG123"}
    assert assistant[1]["toolUse"]["input"] == {"city": "Kolkata"}
    assert req["messages"][2]["content"][0]["toolResult"]["toolUseId"] == "tooluse_1"
    assert req["additionalModelRequestFields"]["thinking"]["type"] == "adaptive"


def test_tool_loop_without_stash_disables_thinking(env):
    client, fake, _ = env
    key = make_key(client)
    oai(client, key).chat.completions.create(model="claude-opus", messages=[
        {"role": "user", "content": "q"},
        {"role": "assistant", "tool_calls": [{"id": "call_x", "type": "function",
                                              "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_x", "content": "r"}])
    req = fake.runtime.calls[-1][1]
    assert req["additionalModelRequestFields"]["thinking"] == {"type": "disabled"}
    assert req["toolConfig"]["tools"][0]["toolSpec"]["name"] == "f"   # synthesized toolConfig


def test_json_schema_response_format(env):
    client, fake, _ = env
    key = make_key(client)
    resp = oai(client, key).chat.completions.create(
        model="smart", messages=[{"role": "user", "content": "weather json"}],
        response_format={"type": "json_schema", "json_schema": {"name": "weather", "schema": {
            "type": "object", "properties": {"city": {"type": "string"}, "temp_c": {"type": "number"}}}}})
    assert json.loads(resp.choices[0].message.content) == {"city": "Kolkata", "temp_c": 31}
    assert resp.choices[0].finish_reason == "stop"
    req = fake.runtime.calls[-1][1]
    assert req["toolConfig"]["toolChoice"] == {"tool": {"name": "json_response"}}
    assert req["additionalModelRequestFields"]["thinking"] == {"type": "disabled"}


def test_fallback_on_throttle(env):
    client, fake, _ = env
    client.put("/api/aliases/chain", json={"targets": ["global.anthropic.claude-opus-5-5", "openai.gpt-oss-120b-1:0"]})
    fake.runtime.fail_models["global.anthropic.claude-opus-5-5"] = "ThrottlingException"
    key = make_key(client)
    r = oai(client, key).chat.completions.with_raw_response.create(model="chain", messages=[{"role": "user", "content": "x"}])
    assert r.headers["x-portal-model"] == "openai.gpt-oss-120b-1:0"
    assert r.headers["x-portal-attempt"] == "2"


def test_throttle_without_fallback_is_429(env):
    client, fake, _ = env
    fake.runtime.fail_models["openai.gpt-oss-120b-1:0"] = "ThrottlingException"
    key = make_key(client)
    with pytest.raises(openai.RateLimitError):
        oai(client, key).chat.completions.create(model="openai.gpt-oss-120b-1:0", messages=[{"role": "user", "content": "x"}])
    assert logs(client)[0]["status"] == 429


def test_budget_allowlist_and_rpm(env):
    client, fake, _ = env
    key = make_key(client, monthly_budget_usd=0.002, allowed_models=["fast"])
    c = oai(client, key)
    with pytest.raises(openai.PermissionDeniedError):
        c.chat.completions.create(model="smart", messages=[{"role": "user", "content": "x"}])
    c.chat.completions.create(model="fast", messages=[{"role": "user", "content": "x"}])  # costs ~$0.0037 > budget
    usage.flush()
    with pytest.raises(openai.RateLimitError) as ei:
        c.chat.completions.create(model="fast", messages=[{"role": "user", "content": "x"}])
    assert ei.value.code == "insufficient_quota"
    ids = [m.id for m in c.models.list().data]
    assert ids == ["fast"]

    key2 = make_key(client, rpm_limit=2)
    c2 = oai(client, key2)
    c2.models.list()
    c2.models.list()
    with pytest.raises(openai.RateLimitError):
        c2.models.list()


def test_disabled_and_unknown_models(env):
    client, fake, _ = env
    key = make_key(client)
    c = oai(client, key)
    with pytest.raises(openai.NotFoundError):
        c.chat.completions.create(model="does-not-exist", messages=[{"role": "user", "content": "x"}])
    with pytest.raises(openai.PermissionDeniedError):
        c.chat.completions.create(model="us.anthropic.claude-opus-5-5", messages=[{"role": "user", "content": "x"}])
    with pytest.raises(openai.AuthenticationError):
        oai(client, "sk-portal-wrong").models.list()


def test_embeddings_base64_default(env):
    client, fake, _ = env
    key = make_key(client)
    resp = oai(client, key).embeddings.create(model="text-embedding-3-small", input=["ab", "abcd"])
    assert [list(d.embedding) for d in resp.data] == [[0.5, -0.25, 2.0], [0.5, -0.25, 4.0]]
    raw = client.post("/v1/embeddings", json={"model": "embed", "input": "x", "encoding_format": "float"},
                      headers={"Authorization": f"Bearer {key}"}).json()
    assert raw["data"][0]["embedding"] == [0.5, -0.25, 1.0]
    bad = client.post("/v1/embeddings", json={"model": "embed", "input": [[1, 2, 3]]},
                      headers={"Authorization": f"Bearer {key}"})
    assert bad.status_code == 400 and "check_embedding_ctx_length" in bad.json()["error"]["message"]


def test_response_cache(env):
    client, fake, _ = env
    key = make_key(client)
    h = {"Authorization": f"Bearer {key}", "x-portal-cache": "1"}
    body = {"model": "fast", "messages": [{"role": "user", "content": "cache me"}]}
    n0 = len(fake.runtime.calls)
    a = client.post("/v1/chat/completions", json=body, headers=h)
    b = client.post("/v1/chat/completions", json=body, headers=h)
    assert len(fake.runtime.calls) == n0 + 1
    assert b.headers["x-portal-cache"] == "hit" and b.json()["usage"]["cost"] == 0
    assert a.json()["choices"] == b.json()["choices"]


def test_images_and_files(env):
    client, fake, _ = env
    key = make_key(client)
    resp = oai(client, key).images.generate(model="dall-e-3", prompt="a cat", n=2, size="1024x1024")
    assert len(resp.data) == 2
    path = resp.data[0].url.split("testserver")[1]
    assert client.get(path).content.startswith(b"\x89PNG")
    usage.flush()
    row = logs(client)[0]
    assert row["cost_usd"] == pytest.approx(0.08)


def test_speech_with_engine_fallback(env):
    client, fake, _ = env
    key = make_key(client)
    r = client.post("/v1/audio/speech", json={"model": "tts-1-hd", "input": "Hello there", "voice": "ballad"},
                    headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 200, r.text
    assert r.headers["x-portal-voice"] == "Brian" and r.headers["x-portal-engine"] == "neural"
    assert r.content.startswith(b"ID3")
    wav = client.post("/v1/audio/speech", json={"input": "Hi", "voice": "alloy", "response_format": "wav"},
                      headers={"Authorization": f"Bearer {key}"})
    assert wav.content[:4] == b"RIFF"


def test_transcription_via_converse_audio(env):
    client, fake, _ = env
    key = make_key(client)
    resp = oai(client, key).audio.transcriptions.create(model="whisper-1", file=("a.mp3", b"ID3xxxx"))
    assert resp.text == "hello world"
    req = fake.runtime.calls[-1][1]
    assert req["messages"][0]["content"][0]["audio"]["format"] == "mp3"


def test_rerank(env):
    client, fake, _ = env
    key = make_key(client)
    r = client.post("/v1/rerank", json={"query": "q", "documents": ["a", "b", "c"], "top_n": 2},
                    headers={"Authorization": f"Bearer {key}"}).json()
    assert [x["index"] for x in r["results"]][0] == 2
    assert r["usage"]["cost"] == pytest.approx(0.002)


def test_anthropic_messages_sdk(env):
    client, fake, _ = env
    key = make_key(client)
    a = anthropic.Anthropic(base_url="http://testserver", auth_token=key, http_client=client, max_retries=0)
    msg = a.messages.create(model="claude-opus-5-5", max_tokens=100, messages=[{"role": "user", "content": "hi"}],
                            metadata={"user_id": "u1"})
    assert msg.content[0].text == "Hi from Claude"
    call = [c for c in fake.runtime.calls if c[0] == "invoke_model"][-1][1]
    assert call["modelId"] == "global.anthropic.claude-opus-5-5"
    assert "metadata" not in json.loads(call["body"])  # self-healed after Bedrock rejected it

    with a.messages.stream(model="claude-haiku-4-5-20251001", max_tokens=50,
                           messages=[{"role": "user", "content": "hi"}]) as s:
        text = "".join(s.text_stream)
        final = s.get_final_message()
    assert text == "Streamed" and final.usage.output_tokens == 7
    call = [c for c in fake.runtime.calls if c[0] == "invoke_model_with_response_stream"][-1][1]
    assert call["modelId"] == "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    n = a.messages.count_tokens(model="claude-opus-5-5", messages=[{"role": "user", "content": "hi"}])
    assert n.input_tokens == 42
    with pytest.raises(anthropic.NotFoundError):
        a.messages.create(model="claude-unknown-9", max_tokens=10, messages=[{"role": "user", "content": "x"}])
    usage.flush()
    rows = [r for r in logs(client) if r["endpoint"] == "messages" and r["status"] == 200]
    assert any(r["cost_usd"] > 0 for r in rows)


def test_presets(env):
    client, fake, _ = env
    client.put("/api/presets/summarizer", json={"model": "fast", "system_prompt": "Summarize.",
                                                "params": {"max_tokens": 77}})
    key = make_key(client)
    oai(client, key).chat.completions.create(model="preset/summarizer", messages=[{"role": "user", "content": "text"}])
    req = fake.runtime.calls[-1][1]
    assert req["system"][0]["text"] == "Summarize." and req["inferenceConfig"]["maxTokens"] == 77


def test_admin_overview_logs_and_recalc(env):
    client, fake, _ = env
    key = make_key(client)
    oai(client, key).chat.completions.create(model="fast", messages=[{"role": "user", "content": "x"}])
    usage.flush()
    ov = client.get("/api/overview?days=7").json()
    assert ov["month"]["requests"] >= 1 and ov["month"]["cost"] > 0 and len(ov["series"]) == 7
    lid = logs(client)[0]["id"]
    detail = client.get(f"/api/logs/{lid}").json()
    assert detail["request_body"]["model"] == "fast"
    exported = client.get("/api/logs/export").text.strip().splitlines()
    assert json.loads(exported[0])["id"]
    client.put("/api/prices", json={"model_prefix": "anthropic.claude-haiku-4-5", "input_per_m": 100, "output_per_m": 100})
    assert client.post("/api/prices/recalculate", json={"days": 1}).json()["updated"] >= 1
    assert db.scalar("SELECT cost_usd FROM requests WHERE id = ?", (lid,)) > 0.1
    assert client.get("/api/overview", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_converse_image_part_and_gpt_oss_reasoning(env):
    client, fake, _ = env
    key = make_key(client)
    png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    oai(client, key).chat.completions.create(model="openai.gpt-oss-120b-1:0", reasoning_effort="high", messages=[
        {"role": "user", "content": [{"type": "text", "text": "what"}, {"type": "image_url", "image_url": {"url": png}}]}])
    req = fake.runtime.calls[-1][1]
    assert req["messages"][0]["content"][1]["image"]["format"] == "png"
    assert req["additionalModelRequestFields"]["reasoning_effort"] == "high"


def test_aws_error_mapping(env):
    client, fake, _ = env
    fake.runtime.fail_models["openai.gpt-oss-120b-1:0"] = "AccessDeniedException"
    key = make_key(client)
    with pytest.raises(openai.PermissionDeniedError):
        oai(client, key).chat.completions.create(model="openai.gpt-oss-120b-1:0", messages=[{"role": "user", "content": "x"}])
    fake.runtime.fail_models["openai.gpt-oss-120b-1:0"] = "ValidationException"
    with pytest.raises(openai.BadRequestError):
        oai(client, key).chat.completions.create(model="openai.gpt-oss-120b-1:0", messages=[{"role": "user", "content": "x"}])
    assert isinstance(FakeClientError("x"), Exception)


def test_review_regressions(env):
    client, fake, _ = env
    key = make_key(client)
    c = oai(client, key)
    # empty stop strings are dropped (botocore would reject them client-side)
    c.chat.completions.create(model="fast", stop=[""], messages=[{"role": "user", "content": "x"}])
    assert "stopSequences" not in fake.runtime.calls[-1][1].get("inferenceConfig", {})
    # forced tool on Claude 5 keeps the forced choice and disables default thinking
    c.chat.completions.create(model="smart", tool_choice="required", messages=[{"role": "user", "content": "x"}],
                              tools=[{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}])
    req = fake.runtime.calls[-1][1]
    assert req["toolConfig"]["toolChoice"] == {"any": {}}
    assert req["additionalModelRequestFields"]["thinking"] == {"type": "disabled"}
    # botocore ParamValidationError -> 400, not retried
    from botocore.exceptions import ParamValidationError
    from app import aws as aws_mod
    from app.errors import from_aws
    e = ParamValidationError(report="bad")
    assert not aws_mod.is_retryable(e) and from_aws(e).status == 400
    # path traversal / UNC names rejected
    assert client.get("/files/images/%5C%5Chost%5Cshare%5Cx.png").status_code == 404
    # cross-origin login blocked
    r = client.post("/api/auth/login", json={"password": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    # Claude Code betas filtered to Bedrock-supported ones
    a = anthropic.Anthropic(base_url="http://testserver", auth_token=key, http_client=client, max_retries=0)
    a.messages.create(model="claude-opus-5-5", max_tokens=10, messages=[{"role": "user", "content": "hi"}],
                      extra_headers={"anthropic-beta": "claude-code-20250219,context-1m-2025-08-07"})
    body = json.loads([x for x in fake.runtime.calls if x[0] == "invoke_model"][-1][1]["body"])
    assert body["anthropic_beta"] == ["context-1m-2025-08-07"]
    # malformed admin token does not crash
    assert client.get("/api/overview", headers={"Authorization": "Bearer adm.x.y"}).status_code == 401
