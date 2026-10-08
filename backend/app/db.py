"""SQLite storage. One file, WAL mode, a connection per thread."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterable

from . import config

_local = threading.local()
_write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    allowed_models TEXT NOT NULL DEFAULT '[]',     -- JSON list; empty = all enabled models
    monthly_budget_usd REAL,                        -- NULL = unlimited
    rpm_limit INTEGER,                              -- NULL = unlimited
    expires_at REAL,                                -- unix ts, NULL = never
    disabled INTEGER NOT NULL DEFAULT 0,
    store_bodies INTEGER NOT NULL DEFAULT 1,
    cache_enabled INTEGER NOT NULL DEFAULT 0,
    guardrail_id TEXT,
    guardrail_version TEXT,
    notes TEXT,
    created_at REAL NOT NULL,
    last_used_at REAL
);

CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,               -- what you send as `model` (base id or inference profile id)
    base_model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,                -- chat | embedding | image | rerank | speech | transcription | video | other
    input_modalities TEXT NOT NULL DEFAULT '[]',
    output_modalities TEXT NOT NULL DEFAULT '[]',
    streaming INTEGER NOT NULL DEFAULT 1,
    route TEXT NOT NULL,               -- on_demand | profile_global | profile_geo | virtual
    lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'aws',-- aws | builtin | custom
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS aliases (
    name TEXT PRIMARY KEY,
    targets TEXT NOT NULL,             -- JSON ordered list of model ids (fallback chain)
    description TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
    name TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    system_prompt TEXT,
    params TEXT NOT NULL DEFAULT '{}', -- JSON: temperature, max_tokens, reasoning_effort, ...
    description TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
    model_prefix TEXT PRIMARY KEY,     -- matched by longest prefix against the base model id
    input_per_m REAL NOT NULL DEFAULT 0,
    output_per_m REAL NOT NULL DEFAULT 0,
    cache_read_per_m REAL,
    cache_write_per_m REAL,
    per_image REAL,
    per_1k_queries REAL,
    per_1m_chars REAL,
    per_minute REAL,
    geo_markup INTEGER NOT NULL DEFAULT 0,  -- 1 = regional/geo profiles cost +markup vs global
    custom INTEGER NOT NULL DEFAULT 0,      -- 1 = edited by the user (survives reset of defaults)
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    ts REAL NOT NULL,
    key_id INTEGER,
    key_name TEXT,
    endpoint TEXT NOT NULL,
    requested_model TEXT,
    resolved_model TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    stream INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL,
    error_code TEXT,
    error_message TEXT,
    ttft_ms INTEGER,
    latency_ms INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    units REAL NOT NULL DEFAULT 0,       -- images / characters / queries for non-token endpoints
    cost_usd REAL NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    finish_reason TEXT,
    session_id TEXT,
    request_body TEXT,
    response_body TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_key_ts ON requests(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts ON requests(resolved_model, ts);

CREATE TABLE IF NOT EXISTS response_cache (
    hash TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS reasoning_stash (
    tool_call_id TEXT PRIMARY KEY,
    blocks TEXT NOT NULL,              -- JSON list of Converse reasoningContent blocks
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "path", None) != str(config.DB_PATH):
        c = _connect()
        _local.conn = c
        _local.path = str(config.DB_PATH)
    return c


def init() -> None:
    with _write_lock:
        c = conn()
        c.executescript(SCHEMA)
        c.commit()


def query(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    cur = conn().execute(sql, tuple(params))
    return [dict(r) for r in cur.fetchall()]


def one(sql: str, params: Iterable[Any] = ()) -> dict | None:
    cur = conn().execute(sql, tuple(params))
    r = cur.fetchone()
    return dict(r) if r else None


def scalar(sql: str, params: Iterable[Any] = ()) -> Any:
    cur = conn().execute(sql, tuple(params))
    r = cur.fetchone()
    return r[0] if r else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    with _write_lock:
        c = conn()
        cur = c.execute(sql, tuple(params))
        c.commit()
        return cur.rowcount


def executemany(sql: str, rows: Iterable[Iterable[Any]]) -> None:
    with _write_lock:
        c = conn()
        c.executemany(sql, [tuple(r) for r in rows])
        c.commit()


@contextmanager
def transaction():
    with _write_lock:
        c = conn()
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


def jload(value: str | None, default: Any = None) -> Any:
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def jdump(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str)
