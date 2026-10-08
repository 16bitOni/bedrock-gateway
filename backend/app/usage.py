"""Request logging (background writer) and usage aggregation."""
from __future__ import annotations

import hashlib
import json
import queue
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import db, pricing, settings

_q: "queue.Queue[tuple]" = queue.Queue()
_worker: threading.Thread | None = None
_DATA_URI = re.compile(r"data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{200,}")
MAX_BODY_CHARS = 200_000


def _scrub(value: Any) -> Any:
    """Shrink big base64 payloads (images/audio/embeddings) before storing bodies."""
    if isinstance(value, str):
        if len(value) > 2000 and re.fullmatch(r"[A-Za-z0-9+/=\s]+", value[:2000]):
            return f"<base64 {len(value)} chars>"
        return _DATA_URI.sub(lambda m: f"data:{m.group(1)};base64,<{len(m.group(0))} chars>", value)
    if isinstance(value, list):
        if len(value) > 64 and all(isinstance(x, (int, float)) for x in value[:64]):
            return f"<vector dim={len(value)}>"
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    return value


def dump_body(value: Any) -> str | None:
    if value is None:
        return None
    try:
        s = json.dumps(_scrub(value), default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        s = str(value)
    if len(s) > MAX_BODY_CHARS:
        s = s[:MAX_BODY_CHARS] + f'… <truncated {len(s) - MAX_BODY_CHARS} chars>'
    return s


def _run_worker() -> None:
    cols = None
    while True:
        item = _q.get()
        if item is None:
            break
        sql, params = item
        try:
            db.execute(sql, params)
        except Exception as e:  # noqa: BLE001
            print(f"[portal] failed to write log row: {e}")
        finally:
            _q.task_done()
    del cols


def start_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_run_worker, name="portal-log-writer", daemon=True)
        _worker.start()


def flush(timeout: float = 5.0) -> None:
    end = time.time() + timeout
    while _q.unfinished_tasks and time.time() < end:
        time.sleep(0.01)


@dataclass
class RequestLog:
    endpoint: str
    key: dict
    requested_model: str | None = None
    stream: bool = False
    session_id: str | None = None
    id: str = field(default_factory=lambda: "req_" + uuid.uuid4().hex[:24])
    started: float = field(default_factory=time.time)
    resolved_model: str | None = None
    attempt: int = 1
    ttft_ms: int | None = None
    request_body: Any = None
    response_body: Any = None
    usage: pricing.Usage = field(default_factory=pricing.Usage)
    cost_usd: float = 0.0
    cached: bool = False
    finish_reason: str | None = None
    _done: bool = False

    def mark_first_token(self) -> None:
        if self.ttft_ms is None:
            self.ttft_ms = int((time.time() - self.started) * 1000)

    def compute_cost(self) -> float:
        if self.cached or not self.resolved_model:
            self.cost_usd = 0.0
        else:
            self.cost_usd = pricing.cost(self.resolved_model, self.usage)
        return self.cost_usd

    def finish(self, status: int = 200, error_code: str | None = None, error_message: str | None = None) -> None:
        if self._done:
            return
        self._done = True
        if status in (200, 499):
            self.compute_cost()
        store = bool(settings.get("log_bodies")) and bool(self.key.get("store_bodies", 1))
        u = self.usage
        units = u.images or u.queries or u.characters or u.minutes or 0
        params = (
            self.id, self.started, self.key.get("id"), self.key.get("name"), self.endpoint, self.requested_model,
            self.resolved_model, self.attempt, int(self.stream), status, error_code,
            (error_message or "")[:4000] or None, self.ttft_ms, int((time.time() - self.started) * 1000),
            u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, units, self.cost_usd,
            int(self.cached), self.finish_reason, self.session_id,
            dump_body(self.request_body) if store else None,
            dump_body(self.response_body) if store else None,
        )
        sql = ("INSERT INTO requests(id, ts, key_id, key_name, endpoint, requested_model, resolved_model, attempt, "
               "stream, status, error_code, error_message, ttft_ms, latency_ms, input_tokens, output_tokens, "
               "cache_read_tokens, cache_write_tokens, units, cost_usd, cached, finish_reason, session_id, "
               "request_body, response_body) VALUES(" + ",".join("?" * 25) + ")")
        start_worker()
        _q.put((sql, params))


# ---------------------------------------------------------------------------
# Exact-match response cache
# ---------------------------------------------------------------------------

def cache_key(endpoint: str, model: str, body: dict) -> str:
    clean = {k: v for k, v in body.items() if k not in ("user", "metadata", "stream_options")}
    raw = endpoint + "|" + model + "|" + json.dumps(clean, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def cache_get(h: str) -> dict | None:
    ttl = float(settings.get("cache_ttl_hours") or 24) * 3600
    r = db.one("SELECT body, created_at FROM response_cache WHERE hash = ?", (h,))
    if not r or time.time() - r["created_at"] > ttl:
        return None
    return db.jload(r["body"])


def cache_put(h: str, body: dict) -> None:
    db.execute("INSERT OR REPLACE INTO response_cache(hash, body, created_at) VALUES(?,?,?)",
               (h, db.jdump(body), time.time()))


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

def purge_old() -> int:
    days = int(settings.get("log_retention_days") or 0)
    n = 0
    if days > 0:
        n = db.execute("DELETE FROM requests WHERE ts < ?", (time.time() - days * 86400,))
    ttl = float(settings.get("cache_ttl_hours") or 24) * 3600
    db.execute("DELETE FROM response_cache WHERE created_at < ?", (time.time() - ttl,))
    db.execute("DELETE FROM reasoning_stash WHERE created_at < ?", (time.time() - 7 * 86400,))
    return n
