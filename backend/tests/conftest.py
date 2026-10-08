"""Test fixtures: a fake AWS (Bedrock/Polly) so the whole gateway runs without credentials."""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["PORTAL_TESTING"] = "1"


from botocore.exceptions import ClientError


class FakeClientError(ClientError):
    def __init__(self, code: str, message: str = "", status: int = 400):
        super().__init__({"Error": {"Code": code, "Message": message or code},
                          "ResponseMetadata": {"HTTPStatusCode": status}}, "FakeOperation")


FOUNDATION_MODELS = [
    {"modelId": "anthropic.claude-opus-5-5", "modelName": "Claude Opus 5.5", "providerName": "Anthropic",
     "inputModalities": ["TEXT", "IMAGE"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["INFERENCE_PROFILE"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "anthropic.claude-sonnet-5-5", "modelName": "Claude Sonnet 5.5", "providerName": "Anthropic",
     "inputModalities": ["TEXT", "IMAGE"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["INFERENCE_PROFILE"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "anthropic.claude-haiku-4-5-20251001-v1:0", "modelName": "Claude Haiku 4.5", "providerName": "Anthropic",
     "inputModalities": ["TEXT", "IMAGE"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["INFERENCE_PROFILE"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "amazon.nova-2-lite-v1:0", "modelName": "Nova 2 Lite", "providerName": "Amazon",
     "inputModalities": ["TEXT", "IMAGE", "VIDEO"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["INFERENCE_PROFILE"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "openai.gpt-oss-120b-1:0", "modelName": "gpt-oss-120b", "providerName": "OpenAI",
     "inputModalities": ["TEXT"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "amazon.titan-embed-text-v2:0", "modelName": "Titan Text Embeddings V2", "providerName": "Amazon",
     "inputModalities": ["TEXT"], "outputModalities": ["EMBEDDING"], "responseStreamingSupported": False,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "amazon.nova-canvas-v1:0", "modelName": "Nova Canvas", "providerName": "Amazon",
     "inputModalities": ["TEXT", "IMAGE"], "outputModalities": ["IMAGE"], "responseStreamingSupported": False,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "cohere.rerank-v3-5:0", "modelName": "Rerank 3.5", "providerName": "Cohere",
     "inputModalities": ["TEXT"], "outputModalities": ["TEXT"], "responseStreamingSupported": False,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "mistral.voxtral-mini-3b-2507", "modelName": "Voxtral Mini", "providerName": "Mistral AI",
     "inputModalities": ["TEXT", "SPEECH"], "outputModalities": ["TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "amazon.nova-2-sonic-v1:0", "modelName": "Nova 2 Sonic", "providerName": "Amazon",
     "inputModalities": ["SPEECH"], "outputModalities": ["SPEECH", "TEXT"], "responseStreamingSupported": True,
     "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
]


def _profile(pid: str, base: str) -> dict:
    return {"inferenceProfileId": pid, "inferenceProfileName": pid, "inferenceProfileArn": f"arn:aws:bedrock:us-east-1:1:inference-profile/{pid}",
            "models": [{"modelArn": f"arn:aws:bedrock:us-east-1::foundation-model/{base}"}], "status": "ACTIVE",
            "type": "SYSTEM_DEFINED"}


PROFILES = [
    _profile("global.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"),
    _profile("us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"),
    _profile("global.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"),
    _profile("global.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic.claude-haiku-4-5-20251001-v1:0"),
    _profile("us.amazon.nova-2-lite-v1:0", "amazon.nova-2-lite-v1:0"),
    _profile("global.amazon.nova-2-lite-v1:0", "amazon.nova-2-lite-v1:0"),
]


class FakeBedrock:
    def list_foundation_models(self, **_):
        return {"modelSummaries": FOUNDATION_MODELS}

    def list_inference_profiles(self, typeEquals="SYSTEM_DEFINED", **_):
        return {"inferenceProfileSummaries": PROFILES if typeEquals == "SYSTEM_DEFINED" else []}


class FakeRuntime:
    """Scriptable bedrock-runtime. Set .script to control the next responses."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.fail_models: dict[str, str] = {}   # model id -> error code to raise
        self.next_stream: list[dict] | None = None
        self.next_response: dict | None = None

    def _check(self, model_id):
        code = self.fail_models.get(model_id)
        if code:
            raise FakeClientError(code, f"{code} for {model_id}", 429 if "Throttl" in code else 400)

    def converse(self, **kw):
        self.calls.append(("converse", kw))
        self._check(kw["modelId"])
        if self.next_response is not None:
            r, self.next_response = self.next_response, None
            return r
        tc = kw.get("toolConfig", {}).get("toolChoice", {})
        if "tool" in tc:
            name = tc["tool"]["name"]
            return {"output": {"message": {"role": "assistant", "content": [
                {"toolUse": {"toolUseId": "tooluse_json1", "name": name, "input": {"city": "Kolkata", "temp_c": 31}}}]}},
                "stopReason": "tool_use", "usage": {"inputTokens": 50, "outputTokens": 20, "totalTokens": 70}}
        first = kw["messages"][0]["content"]
        if any("audio" in b for b in first):
            return {"output": {"message": {"role": "assistant", "content": [{"text": "hello world"}]}},
                    "stopReason": "end_turn", "usage": {"inputTokens": 300, "outputTokens": 3, "totalTokens": 303}}
        return {"output": {"message": {"role": "assistant", "content": [
            {"reasoningContent": {"reasoningText": {"text": "thinking...", "signature": "sig-abc"}}},
            {"text": "Hello from Bedrock"}]}},
            "stopReason": "end_turn",
            "usage": {"inputTokens": 1000, "outputTokens": 500, "totalTokens": 1500, "cacheReadInputTokens": 2000}}

    def converse_stream(self, **kw):
        self.calls.append(("converse_stream", kw))
        self._check(kw["modelId"])
        events = self.next_stream or [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hel"}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "lo"}}},
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12}, "metrics": {"latencyMs": 5}}},
        ]
        self.next_stream = None
        return {"stream": iter(events)}

    def invoke_model(self, **kw):
        self.calls.append(("invoke_model", kw))
        self._check(kw["modelId"])
        body = json.loads(kw["body"])
        mid = kw["modelId"]
        if "titan-embed" in mid:
            n = len(body["inputText"])
            out = {"embedding": [0.5, -0.25, float(n)], "inputTextTokenCount": 3}
        elif "nova-canvas" in mid:
            png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
            out = {"images": [png] * body["imageGenerationConfig"]["numberOfImages"]}
        elif "claude" in mid:
            assert body["anthropic_version"] == "bedrock-2023-05-31"
            if "metadata" in body:
                raise FakeClientError("ValidationException", "Malformed input request: #: extraneous key [metadata] is not permitted")
            out = {"id": "msg_1", "type": "message", "role": "assistant", "model": mid,
                   "content": [{"type": "text", "text": "Hi from Claude"}], "stop_reason": "end_turn",
                   "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 5}}
        else:
            raise FakeClientError("ValidationException", "unknown model")
        return {"body": io.BytesIO(json.dumps(out).encode())}

    def invoke_model_with_response_stream(self, **kw):
        self.calls.append(("invoke_model_with_response_stream", kw))
        self._check(kw["modelId"])
        evs = [
            {"type": "message_start", "message": {"id": "msg_2", "type": "message", "role": "assistant", "model": "x",
                                                  "content": [], "stop_reason": None, "stop_sequence": None,
                                                  "usage": {"input_tokens": 20, "output_tokens": 1}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Streamed"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 7}},
            {"type": "message_stop", "amazon-bedrock-invocationMetrics": {"inputTokenCount": 20}},
        ]
        return {"body": [{"chunk": {"bytes": json.dumps(e).encode()}} for e in evs]}

    def count_tokens(self, **kw):
        return {"inputTokens": 42}


class FakePolly:
    def synthesize_speech(self, **kw):
        if kw["Engine"] == "generative" and kw["VoiceId"] == "Brian":
            raise FakeClientError("ValidationException", "voice not supported by engine")
        return {"AudioStream": io.BytesIO(b"ID3fake-mp3-" + kw["Engine"].encode())}

    def describe_voices(self, **kw):
        return {"Voices": [{"Id": "Ruth", "Name": "Ruth", "Gender": "Female", "LanguageCode": "en-US",
                            "LanguageName": "US English", "SupportedEngines": ["generative", "neural"]}]}


class FakeAgentRuntime:
    def rerank(self, **kw):
        n = len(kw["sources"])
        return {"results": [{"index": i, "relevanceScore": 1 - i / n} for i in reversed(range(n))]}


class FakeAWS:
    def __init__(self):
        self.runtime = FakeRuntime()
        self.bedrock = FakeBedrock()
        self.polly = FakePolly()
        self.agent = FakeAgentRuntime()

    def factory(self, service, region):
        return {"bedrock-runtime": self.runtime, "bedrock": self.bedrock, "polly": self.polly,
                "bedrock-agent-runtime": self.agent}[service]


@pytest.fixture()
def env(tmp_path, monkeypatch):
    from app import aws, config, db, pricing, settings
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "portal.db")
    monkeypatch.setattr(config, "IMAGES_DIR", tmp_path / "images")
    settings.invalidate()
    pricing.invalidate()
    fake = FakeAWS()
    aws.set_client_factory(fake.factory)
    from fastapi.testclient import TestClient

    from app.main import app
    with TestClient(app) as client:
        r = client.post("/api/auth/setup", json={"password": "correct-horse"})
        admin = r.json()["token"]
        client.headers["Authorization"] = f"Bearer {admin}"
        client.post("/api/models/sync")
        settings.set("retry_attempts", 0)
        yield client, fake, admin
    from app import usage
    usage.flush()
    aws.set_client_factory(None)
    settings.invalidate()
    del db


def make_key(client, **kw):
    body = {"name": "test-key", **kw}
    r = client.post("/api/keys", json=body)
    assert r.status_code == 200, r.text
    return r.json()["key"]
