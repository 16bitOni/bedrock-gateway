"""POST /v1/embeddings (Titan v2, Cohere Embed, Nova multimodal embeddings)."""
from __future__ import annotations

import base64
import json
import struct
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import aws, catalog, translate, usage
from ..auth import authenticate
from ..errors import GatewayError, bad_request
from .common import gateway_headers, read_json, run_with_fallback, session_id, want_cache

router = APIRouter()
_pool = ThreadPoolExecutor(max_workers=16)


def _encode(vec: list[float], fmt: str):
    if fmt == "base64":
        return base64.b64encode(struct.pack(f"<{len(vec)}f", *vec)).decode()
    return vec


def _invoke(model_id: str, payload: dict) -> dict:
    resp = aws.client("bedrock-runtime").invoke_model(
        modelId=model_id, body=json.dumps(payload), contentType="application/json", accept="application/json")
    return json.loads(resp["body"].read())


def _embed(model_id: str, inputs: list[str], body: dict) -> tuple[list[list[float]], int]:
    base = translate.base_id(model_id)
    dims = body.get("dimensions")
    if base.startswith("cohere.embed"):
        input_type = body.get("input_type") or "search_document"
        vectors: list[list[float]] = []
        tokens = 0
        for i in range(0, len(inputs), 96):
            batch = inputs[i:i + 96]
            payload: dict = {"texts": batch, "input_type": input_type, "embedding_types": ["float"]}
            if body.get("truncate"):
                payload["truncate"] = body["truncate"]
            elif "v4" not in base:
                payload["truncate"] = "END"
            if dims and "v4" in base:
                payload["output_dimension"] = int(dims)
            out = _invoke(model_id, payload)
            emb = out.get("embeddings")
            if isinstance(emb, dict):
                emb = emb.get("float")
            vectors.extend(emb or [])
            tokens += sum(max(1, len(t) // 4) for t in batch)
        return vectors, tokens

    if base.startswith("amazon.nova-2-multimodal-embeddings"):
        def one(text: str):
            payload = {"schemaVersion": "nova-multimodal-embed-v1", "taskType": "SINGLE_EMBEDDING",
                       "singleEmbeddingParams": {
                           "embeddingPurpose": body.get("embedding_purpose") or "GENERIC_INDEX",
                           "embeddingDimension": int(dims or 1024),
                           "text": {"value": text, "truncationMode": "END"}}}
            out = _invoke(model_id, payload)
            return out["embeddings"][0]["embedding"], max(1, len(text) // 4)
        results = list(_pool.map(one, inputs))
        return [r[0] for r in results], sum(r[1] for r in results)

    if base.startswith("amazon.titan-embed"):
        def one(text: str):
            payload: dict = {"inputText": text}
            if "v2" in base:
                payload["normalize"] = True
                if dims:
                    if int(dims) not in (256, 512, 1024):
                        raise bad_request("Titan v2 supports dimensions 256, 512 or 1024.", param="dimensions")
                    payload["dimensions"] = int(dims)
            out = _invoke(model_id, payload)
            return out["embedding"], int(out.get("inputTextTokenCount") or 0)
        results = list(_pool.map(one, inputs))
        return [r[0] for r in results], sum(r[1] for r in results)

    raise bad_request(f"`{model_id}` is not a supported embedding model (Titan, Cohere Embed, Nova embeddings).",
                      param="model")


@router.post("/v1/embeddings")
@router.post("/embeddings", include_in_schema=False)
async def embeddings(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    log = usage.RequestLog(endpoint="embeddings", key=key, requested_model=body.get("model"),
                           session_id=session_id(request))
    log.request_body = body
    try:
        raw = body.get("input")
        if isinstance(raw, str):
            inputs = [raw]
        elif isinstance(raw, list) and all(isinstance(x, str) for x in raw):
            inputs = raw
        elif isinstance(raw, list):
            raise bad_request("Token-id arrays are not supported; send strings. With LangChain use "
                              "OpenAIEmbeddings(..., check_embedding_ctx_length=False).", param="input")
        else:
            raise bad_request("`input` must be a string or a list of strings.", param="input")
        if not inputs or any(not s for s in inputs):
            raise bad_request("`input` must not be empty.", param="input")
        fmt = body.get("encoding_format") or "float"
        if fmt not in ("float", "base64"):
            raise bad_request("encoding_format must be `float` or `base64`.", param="encoding_format")
        resolved = catalog.resolve(body.get("model") or "", key, kind="embedding")
        return await run_in_threadpool(_run, request, body, inputs, fmt, resolved, key, log)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise


def _run(request, body, inputs, fmt, resolved, key, log):
    cache_hash = None
    if want_cache(request, key):
        cache_hash = usage.cache_key("embeddings", resolved.primary, body)
        hit = usage.cache_get(cache_hash)
        if hit:
            log.cached, log.resolved_model = True, resolved.primary
            log.finish(200)
            hit = {**hit, "usage": {**(hit.get("usage") or {}), "cost": 0.0}}
            return JSONResponse(hit, headers=gateway_headers(log, {"x-portal-cache": "hit", "x-portal-cost-usd": "0"}))
    model_used, (vectors, tokens) = run_with_fallback(resolved, log, lambda m: _embed(m, inputs, body))
    log.usage.input_tokens = tokens
    cost = log.compute_cost()
    result = {
        "object": "list",
        "data": [{"object": "embedding", "index": i, "embedding": _encode(v, fmt)} for i, v in enumerate(vectors)],
        "model": body.get("model") or model_used,
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens, "cost": round(cost, 8)},
    }
    log.response_body = {"count": len(vectors), "dimensions": len(vectors[0]) if vectors else 0}
    log.finish(200)
    if cache_hash:
        usage.cache_put(cache_hash, result)
    return JSONResponse(result, headers=gateway_headers(log, {"x-portal-cost-usd": f"{cost:.8f}"}))
