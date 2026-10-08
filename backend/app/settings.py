"""Runtime settings stored in SQLite and editable from the dashboard."""
from __future__ import annotations

import secrets
import threading
import time
from typing import Any

from . import config, db

DEFAULTS: dict[str, Any] = {
    # --- AWS connection ---
    "aws_auth_mode": "default_chain",   # assume_role | default_chain | static_keys
    "aws_region": "us-east-1",
    "aws_role_arn": "",
    "aws_external_id": "",              # generated on first start
    "aws_profile": "",                  # optional named profile for the source credentials
    "aws_access_key_id": "",            # only for static_keys mode
    "aws_secret_access_key": "",        # only for static_keys mode (never returned by the API)
    "aws_session_duration": 3600,
    # --- Gateway behaviour ---
    "default_max_tokens": 4096,
    "retry_attempts": 2,                # retries per model on throttling / 5xx before falling back
    "auto_prompt_cache": True,          # add Bedrock cache points to long system prompts / tool lists
    "log_bodies": True,                 # store request/response bodies (per-key switch also applies)
    "log_retention_days": 90,
    "cache_ttl_hours": 24,              # exact-match response cache (opt-in per key or x-portal-cache header)
    "monthly_budget_usd": None,         # global hard cap for the calendar month (None = unlimited)
    "budget_alert_pct": 80,
    "geo_profile_markup": 1.10,         # price multiplier for us./eu./apac. profiles vs global. on models flagged geo_markup
    "public_base_url": "",              # used in code snippets and image URLs (defaults to the request host)
    "anthropic_betas": [],              # allow-list for anthropic-beta flags on /v1/messages (empty = built-in list)
    # --- Voice ---
    "tts_default_engine": "generative",
    "stt_model": "mistral.voxtral-mini-3b-2507",
    "transcribe_s3_bucket": "",         # optional: enables the `aws-transcribe` model (Amazon Transcribe batch)
    # --- Billing ---
    "billing_enabled": True,            # call Cost Explorer / Billing for actual AWS spend and credits
    "billing_cache_hours": 6,
    # --- Internal ---
    "admin_password_hash": "",
    "admin_secret": "",
    "catalog_synced_at": 0,
}

SECRET_KEYS = {"aws_secret_access_key", "admin_password_hash", "admin_secret"}

_cache: dict[str, Any] = {}
_cache_at = 0.0
_lock = threading.Lock()


def _load() -> dict[str, Any]:
    global _cache, _cache_at
    with _lock:
        if _cache and time.time() - _cache_at < 2:
            return _cache
        rows = db.query("SELECT key, value FROM settings")
        data = dict(DEFAULTS)
        for r in rows:
            data[r["key"]] = db.jload(r["value"], DEFAULTS.get(r["key"]))
        _cache = data
        _cache_at = time.time()
        return data


def invalidate() -> None:
    global _cache_at
    with _lock:
        _cache_at = 0.0


def get(key: str) -> Any:
    return _load().get(key, DEFAULTS.get(key))


def all_settings() -> dict[str, Any]:
    return dict(_load())


def set_many(values: dict[str, Any]) -> None:
    rows = [(k, db.jdump(v)) for k, v in values.items()]
    db.executemany(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rows,
    )
    invalidate()


def set(key: str, value: Any) -> None:  # noqa: A001 - mirrors get()
    set_many({key: value})


def public_view() -> dict[str, Any]:
    data = all_settings()
    out = {k: v for k, v in data.items() if k not in SECRET_KEYS}
    out["aws_secret_access_key_set"] = bool(data.get("aws_secret_access_key"))
    return out


def bootstrap() -> None:
    """Seed settings from the environment and generate secrets on first start."""
    existing = {r["key"] for r in db.query("SELECT key FROM settings")}
    seeds: dict[str, Any] = {}
    for k, v in config.ENV_SEEDS.items():
        if v and k not in existing:
            seeds[k] = v
    if "aws_role_arn" in seeds and "aws_auth_mode" not in seeds and "aws_auth_mode" not in existing:
        seeds["aws_auth_mode"] = "assume_role"
    if "aws_external_id" not in existing and "aws_external_id" not in seeds:
        seeds["aws_external_id"] = "portal-" + secrets.token_hex(12)
    if "admin_secret" not in existing:
        seeds["admin_secret"] = secrets.token_hex(32)
    if seeds:
        set_many(seeds)
