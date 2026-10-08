"""Shared helpers for the API routes: retries/fallbacks, SSE, headers."""
from __future__ import annotations

import json
import time
from typing import Any, Callable, TypeVar

from fastapi import Request

from .. import aws, settings
from ..catalog import Resolved
from ..errors import GatewayError, from_aws
from ..usage import RequestLog

T = TypeVar("T")

FALLTHROUGH_CODES = {"AccessDeniedException", "ResourceNotFoundException", "ModelNotReadyException",
                     "ModelErrorException"}


def _is_context_error(exc: BaseException) -> bool:
    msg = aws.error_message(exc).lower()
    return aws.error_code(exc) == "ValidationException" and (
        "too long" in msg or "context window" in msg or "context length" in msg or "maximum context" in msg
        or "too many tokens" in msg or "input is too long" in msg)


def run_with_fallback(resolved: Resolved, log: RequestLog, fn: Callable[[str], T]) -> tuple[str, T]:
    """Call fn(model_id) for each target in order, retrying throttles with backoff.

    Returns (model_id_used, result). Raises a GatewayError when everything failed.
    """
    retries = max(0, int(settings.get("retry_attempts") or 0))
    last_exc: BaseException | None = None
    for i, target in enumerate(resolved.targets):
        log.resolved_model = target
        log.attempt = i + 1
        has_next = i < len(resolved.targets) - 1
        for r in range(retries + 1):
            try:
                return target, fn(target)
            except GatewayError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if aws.is_retryable(exc):
                    if r < retries:
                        time.sleep(min(8.0, 0.6 * (2 ** r)))
                        continue
                    break  # exhausted retries -> next target
                if has_next and (aws.error_code(exc) in FALLTHROUGH_CODES or _is_context_error(exc)):
                    break
                raise from_aws(exc, target) from exc
    assert last_exc is not None
    raise from_aws(last_exc, resolved.targets[-1]) from last_exc


def sse(data: Any) -> str:
    return "data: " + json.dumps(data, ensure_ascii=False, default=str) + "\n\n"


def sse_event(event: str, data: Any) -> str:
    return f"event: {event}\ndata: " + json.dumps(data, ensure_ascii=False, default=str) + "\n\n"


def gateway_headers(log: RequestLog, extra: dict[str, str] | None = None) -> dict[str, str]:
    h = {"x-request-id": log.id}
    if log.resolved_model:
        h["x-portal-model"] = log.resolved_model
    h["x-portal-attempt"] = str(log.attempt)
    if extra:
        h.update(extra)
    return h


SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


def session_id(request: Request) -> str | None:
    return request.headers.get("x-portal-session") or request.headers.get("x-session-id")


def want_cache(request: Request, key: dict) -> bool:
    h = (request.headers.get("x-portal-cache") or "").lower()
    if h in ("0", "false", "no", "off"):
        return False
    return h in ("1", "true", "yes", "on") or bool(key.get("cache_enabled"))


async def read_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as e:  # noqa: BLE001
        raise GatewayError(400, f"Request body must be JSON: {e}") from e
    if not isinstance(body, dict):
        raise GatewayError(400, "Request body must be a JSON object.")
    return body
