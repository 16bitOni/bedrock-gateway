"""POST /v1/chat/completions (OpenAI-compatible, backed by Bedrock Converse)."""
from __future__ import annotations

import json
from typing import Iterator

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

from .. import aws, catalog, translate, usage
from ..auth import authenticate
from ..errors import GatewayError, from_aws
from .common import (SSE_HEADERS, gateway_headers, read_json, run_with_fallback, session_id, sse, want_cache)

router = APIRouter()


def _close(stream) -> None:
    try:
        if stream is not None and hasattr(stream, "close"):
            stream.close()
    except Exception:  # noqa: BLE001
        pass


def _estimate_tokens(value) -> int:
    return len(json.dumps(value or [], default=lambda o: "x" * 1000)) // 4


@router.post("/v1/chat/completions")
@router.post("/chat/completions", include_in_schema=False)
async def chat_completions(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    stream = bool(body.get("stream"))
    log = usage.RequestLog(endpoint="chat.completions", key=key, requested_model=body.get("model"),
                           stream=stream, session_id=session_id(request))
    log.request_body = body
    try:
        resolved = catalog.resolve(body.get("model") or "", key, kind="chat")
        if stream:
            return await run_in_threadpool(_start_stream, body, resolved, key, log)
        return await run_in_threadpool(_complete, request, body, resolved, key, log)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise
    except Exception as e:  # noqa: BLE001
        log.finish(500, e.__class__.__name__, str(e))
        raise


def _complete(request: Request, body: dict, resolved: catalog.Resolved, key: dict, log: usage.RequestLog):
    cache_hash = None
    if want_cache(request, key):
        cache_hash = usage.cache_key("chat", resolved.primary, body)
        hit = usage.cache_get(cache_hash)
        if hit:
            log.cached = True
            log.resolved_model = resolved.primary
            hit = {**hit, "usage": {**(hit.get("usage") or {}), "cost": 0.0}}
            log.response_body = hit
            log.finish(200)
            return JSONResponse(hit, headers=gateway_headers(log, {"x-portal-cache": "hit", "x-portal-cost-usd": "0"}))

    cid = translate.new_completion_id()

    def call(model_id: str):
        req, ctx = translate.build_converse_request(body, model_id, resolved.preset, key)
        resp = aws.client("bedrock-runtime").converse(**req)
        return translate.converse_to_openai(resp, body.get("model") or model_id, ctx, cid)

    _, (result, u) = run_with_fallback(resolved, log, call)
    log.usage = u
    log.finish_reason = result["choices"][0]["finish_reason"]
    cost = log.compute_cost()
    result["usage"]["cost"] = round(cost, 8)
    log.response_body = result
    log.finish(200)
    if cache_hash:
        usage.cache_put(cache_hash, result)
    return JSONResponse(result, headers=gateway_headers(log, {"x-portal-cost-usd": f"{cost:.8f}"}))


def _start_stream(body: dict, resolved: catalog.Resolved, key: dict, log: usage.RequestLog):
    cid = translate.new_completion_id()
    holder: dict = {}

    def call(model_id: str):
        req, ctx = translate.build_converse_request(body, model_id, resolved.preset, key)
        resp = aws.client("bedrock-runtime").converse_stream(**req)
        holder["ctx"] = ctx
        return resp

    model_used, resp = run_with_fallback(resolved, log, call)
    ctx: translate.ConvCtx = holder["ctx"]
    tr = translate.StreamTranslator(body.get("model") or model_used, ctx, cid)

    def gen() -> Iterator[str]:
        status, err_code, err_msg = 200, None, None
        try:
            yield sse(tr.start_chunk())
            for event in resp["stream"]:
                for name in ("internalServerException", "modelStreamErrorException", "validationException",
                             "throttlingException", "serviceUnavailableException"):
                    if name in event:
                        raise GatewayError(502, f"Bedrock stream error ({name}): "
                                           f"{event[name].get('message') or event[name]}", type="api_error",
                                           code=name)
                chunks = tr.feed(event)
                if chunks:
                    log.mark_first_token()
                for c in chunks:
                    yield sse(c)
            log.usage = tr.usage
            cost = log.compute_cost()
            if ctx.include_usage:
                yield sse(tr.usage_chunk(cost))
            yield "data: [DONE]\n\n"
        except GeneratorExit:  # client closed the connection mid-stream
            status, err_code, err_msg = 499, "client_disconnected", "Client closed the stream"
            _close(resp.get("stream"))
            if not tr.usage.input_tokens:  # usage metadata never arrived: estimate the input side
                tr.usage.input_tokens = _estimate_tokens(body.get("messages"))
                tr.usage.output_tokens = max(tr.usage.output_tokens, sum(len(p) for p in tr.text_parts) // 4)
            raise
        except GatewayError as e:
            status, err_code, err_msg = e.status, e.code, e.message
            yield sse(e.openai_body())
            yield "data: [DONE]\n\n"
        except Exception as e:  # noqa: BLE001 - EventStreamError etc.
            ge = from_aws(e, model_used)
            status, err_code, err_msg = ge.status, ge.code, ge.message
            yield sse(ge.openai_body())
            yield "data: [DONE]\n\n"
        finally:
            log.usage = tr.usage
            log.finish_reason = tr.finish_reason
            log.response_body = tr.final_message()
            log.finish(status, err_code, err_msg)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={**SSE_HEADERS, **gateway_headers(log)})
