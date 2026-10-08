"""Dashboard API (/api/*). Protected by the admin password session."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from .. import __version__, auth, aws, billing, catalog, config, db, pricing, settings
from ..errors import GatewayError, bad_request, from_aws
from .common import read_json

public = APIRouter(prefix="/api")
router = APIRouter(prefix="/api", dependencies=[Depends(auth.require_admin)])


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@public.get("/auth/status")
async def auth_status(request: Request):
    return {"setup_required": not settings.get("admin_password_hash"),
            "signed_in": auth.is_admin_token(auth.bearer(request)), "version": __version__}


def _same_origin(request: Request) -> None:
    """Block cross-site requests to the sign-in endpoints (CORS is open for /v1)."""
    origin = request.headers.get("origin")
    if not origin:
        return
    from urllib.parse import urlparse
    o = urlparse(origin)
    host = request.headers.get("host", "")
    allowed = {host}
    pub = settings.get("public_base_url")
    if pub:
        allowed.add(urlparse(pub).netloc)
    if o.netloc not in allowed and not (o.hostname in ("localhost", "127.0.0.1") and
                                        host.split(":")[0] in ("localhost", "127.0.0.1")):
        raise GatewayError(403, "Cross-origin sign-in is not allowed.", type="permission_error",
                           code="bad_origin")


@public.post("/auth/setup")
async def auth_setup(request: Request):
    _same_origin(request)
    if settings.get("admin_password_hash"):
        raise GatewayError(409, "Admin password already set. Sign in instead.", code="already_setup")
    body = await read_json(request)
    pw = body.get("password") or ""
    if len(pw) < 8:
        raise bad_request("Password must be at least 8 characters.", param="password")
    settings.set("admin_password_hash", auth.hash_password(pw))
    return {"token": auth.issue_admin_token()}


_login_failures: dict[str, list[float]] = {}


@public.post("/auth/login")
async def auth_login(request: Request):
    _same_origin(request)
    ip = request.client.host if request.client else "?"
    now = time.time()
    fails = [t for t in _login_failures.get(ip, []) if now - t < 300]
    if len(fails) >= 10:
        raise GatewayError(429, "Too many failed sign-in attempts. Try again in a few minutes.",
                           type="rate_limit_error", code="too_many_attempts")
    body = await read_json(request)
    stored = settings.get("admin_password_hash")
    if not stored:
        raise GatewayError(401, "Setup required.", code="setup_required", type="authentication_error")
    if not auth.verify_password(body.get("password") or "", stored):
        fails.append(now)
        _login_failures[ip] = fails
        raise GatewayError(401, "Wrong password.", type="authentication_error", code="invalid_password")
    _login_failures.pop(ip, None)
    return {"token": auth.issue_admin_token()}


@router.post("/auth/password")
async def change_password(request: Request):
    body = await read_json(request)
    if not auth.verify_password(body.get("current") or "", settings.get("admin_password_hash")):
        raise GatewayError(401, "Current password is wrong.", type="authentication_error", code="invalid_password")
    new = body.get("new") or ""
    if len(new) < 8:
        raise bad_request("New password must be at least 8 characters.")
    settings.set("admin_password_hash", auth.hash_password(new))
    return {"token": auth.issue_admin_token()}


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------

def _day_start(ts: float | None = None) -> float:
    d = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()


def _totals(since: float) -> dict:
    r = db.one(
        "SELECT COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS input_tokens,"
        " COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,"
        " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS errors FROM requests WHERE ts >= ?",
        (since,))
    return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in (r or {}).items()}


def _pct(values: list[int], p: float) -> int | None:
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * p))]


@router.get("/overview")
async def overview(days: int = 30):
    days = max(1, min(365, days))
    now = time.time()
    today = _day_start(now)
    month = auth.month_start(now)
    since = today - (days - 1) * 86400

    series_rows = db.query(
        "SELECT CAST((ts - ?) / 86400 AS INTEGER) AS d, COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS cost,"
        " COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0) AS input_tokens,"
        " COALESCE(SUM(output_tokens),0) AS output_tokens,"
        " SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors FROM requests WHERE ts >= ? GROUP BY d",
        (since, since))
    by_d = {r["d"]: r for r in series_rows}
    series = []
    for i in range(days):
        r = by_d.get(i, {})
        series.append({
            "date": datetime.fromtimestamp(since + i * 86400, tz=timezone.utc).strftime("%Y-%m-%d"),
            "requests": r.get("requests", 0), "cost": round(r.get("cost", 0) or 0, 6),
            "input_tokens": r.get("input_tokens", 0) or 0, "output_tokens": r.get("output_tokens", 0) or 0,
            "errors": r.get("errors", 0) or 0,
        })

    by_model = db.query(
        "SELECT COALESCE(resolved_model, requested_model) AS model, COUNT(*) AS requests, SUM(cost_usd) AS cost,"
        " SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens"
        " FROM requests WHERE ts >= ? GROUP BY model ORDER BY cost DESC LIMIT 15", (since,))
    by_key = db.query(
        "SELECT key_id, key_name, COUNT(*) AS requests, SUM(cost_usd) AS cost FROM requests WHERE ts >= ?"
        " GROUP BY key_id ORDER BY cost DESC LIMIT 15", (since,))
    by_endpoint = db.query(
        "SELECT endpoint, COUNT(*) AS requests, SUM(cost_usd) AS cost FROM requests WHERE ts >= ?"
        " GROUP BY endpoint ORDER BY requests DESC", (since,))
    errors = db.query(
        "SELECT id, ts, endpoint, requested_model, status, error_code, error_message FROM requests"
        " WHERE status >= 400 ORDER BY ts DESC LIMIT 8")
    lat = db.query("SELECT latency_ms, ttft_ms FROM requests WHERE ts >= ? AND status < 400 AND cached = 0"
                   " ORDER BY ts DESC LIMIT 2000", (now - 86400,))
    lats = [r["latency_ms"] for r in lat if r["latency_ms"] is not None]
    ttfts = [r["ttft_ms"] for r in lat if r["ttft_ms"] is not None]
    cap = settings.get("monthly_budget_usd")
    month_tot = _totals(month)
    key_budgets = []
    for k in db.query("SELECT id, name, monthly_budget_usd FROM api_keys WHERE monthly_budget_usd IS NOT NULL"
                      " AND disabled = 0"):
        spent = auth.month_spend(k["id"])
        key_budgets.append({"id": k["id"], "name": k["name"], "budget": k["monthly_budget_usd"],
                            "spent": round(spent, 6)})
    top_requests = db.query(
        "SELECT id, ts, endpoint, requested_model, resolved_model, cost_usd, input_tokens, output_tokens"
        " FROM requests WHERE ts >= ? ORDER BY cost_usd DESC LIMIT 5", (month,))
    days_elapsed = max(1.0, (now - month) / 86400)
    d = datetime.fromtimestamp(now, tz=timezone.utc)
    next_month = datetime(d.year + (d.month // 12), d.month % 12 + 1, 1, tzinfo=timezone.utc).timestamp()
    days_in_month = (next_month - month) / 86400
    return {
        "today": _totals(today),
        "week": _totals(today - 6 * 86400),
        "month": month_tot,
        "all_time": _totals(0),
        "forecast_month": round(month_tot["cost"] / days_elapsed * days_in_month, 4),
        "series": series,
        "by_model": by_model,
        "by_key": by_key,
        "by_endpoint": by_endpoint,
        "recent_errors": errors,
        "top_requests": top_requests,
        "latency_24h": {"p50": _pct(lats, 0.5), "p95": _pct(lats, 0.95), "ttft_p50": _pct(ttfts, 0.5),
                        "ttft_p95": _pct(ttfts, 0.95)},
        "budget": {"monthly_cap": cap, "spent": month_tot["cost"], "alert_pct": settings.get("budget_alert_pct"),
                   "keys": key_budgets},
        "catalog": {"synced_at": settings.get("catalog_synced_at"),
                    "enabled_models": db.scalar("SELECT COUNT(*) FROM models WHERE enabled = 1"),
                    "total_models": db.scalar("SELECT COUNT(*) FROM models")},
        "keys_count": db.scalar("SELECT COUNT(*) FROM api_keys WHERE disabled = 0"),
    }


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------

def _key_out(r: dict) -> dict:
    k = auth._row_to_key(r)  # noqa: SLF001
    k["month_spend"] = round(auth.month_spend(k["id"]), 6)
    k["month_requests"] = db.scalar("SELECT COUNT(*) FROM requests WHERE key_id = ? AND ts >= ?",
                                    (k["id"], auth.month_start()))
    k["total_spend"] = round(float(db.scalar("SELECT COALESCE(SUM(cost_usd),0) FROM requests WHERE key_id = ?",
                                             (k["id"],)) or 0), 6)
    return k


_KEY_FIELDS = ("name", "allowed_models", "monthly_budget_usd", "rpm_limit", "expires_at", "disabled",
               "store_bodies", "cache_enabled", "guardrail_id", "guardrail_version", "notes")


def _key_values(body: dict) -> dict:
    vals: dict[str, Any] = {}
    for f in _KEY_FIELDS:
        if f in body:
            vals[f] = body[f]
    if "expires_in_days" in body:
        d = body.get("expires_in_days")
        vals["expires_at"] = (time.time() + float(d) * 86400) if d else None
    if "allowed_models" in vals:
        am = vals["allowed_models"] or []
        if not isinstance(am, list):
            raise bad_request("allowed_models must be a list.")
        vals["allowed_models"] = db.jdump([str(x) for x in am])
    for f in ("monthly_budget_usd",):
        if f in vals and vals[f] in ("", None):
            vals[f] = None
    for f in ("rpm_limit",):
        if f in vals:
            vals[f] = int(vals[f]) if vals[f] not in ("", None, 0) else None
    for f in ("disabled", "store_bodies", "cache_enabled"):
        if f in vals:
            vals[f] = int(bool(vals[f]))
    return vals


@router.get("/keys")
async def list_keys():
    return {"data": [_key_out(r) for r in db.query("SELECT * FROM api_keys ORDER BY created_at DESC")]}


@router.post("/keys")
async def create_key(request: Request):
    body = await read_json(request)
    if not (body.get("name") or "").strip():
        raise bad_request("name is required.", param="name")
    raw, h, prefix = auth.generate_key()
    vals = _key_values(body)
    vals.update({"key_hash": h, "prefix": prefix, "created_at": time.time()})
    vals.setdefault("allowed_models", "[]")
    cols = ",".join(vals)
    with db.transaction() as c:
        cur = c.execute(f"INSERT INTO api_keys({cols}) VALUES({','.join('?' * len(vals))})", tuple(vals.values()))
        kid = cur.lastrowid
    out = _key_out(db.one("SELECT * FROM api_keys WHERE id = ?", (kid,)))
    out["key"] = raw
    return out


@router.patch("/keys/{key_id}")
async def update_key(key_id: int, request: Request):
    body = await read_json(request)
    vals = _key_values(body)
    if not vals:
        raise bad_request("Nothing to update.")
    sets = ",".join(f"{k} = ?" for k in vals)
    if db.execute(f"UPDATE api_keys SET {sets} WHERE id = ?", (*vals.values(), key_id)) == 0:
        raise GatewayError(404, "Key not found.", code="not_found")
    return _key_out(db.one("SELECT * FROM api_keys WHERE id = ?", (key_id,)))


@router.post("/keys/{key_id}/rotate")
async def rotate_key(key_id: int):
    raw, h, prefix = auth.generate_key()
    if db.execute("UPDATE api_keys SET key_hash = ?, prefix = ? WHERE id = ?", (h, prefix, key_id)) == 0:
        raise GatewayError(404, "Key not found.", code="not_found")
    out = _key_out(db.one("SELECT * FROM api_keys WHERE id = ?", (key_id,)))
    out["key"] = raw
    return out


@router.delete("/keys/{key_id}")
async def delete_key(key_id: int):
    if db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,)) == 0:
        raise GatewayError(404, "Key not found.", code="not_found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Models, aliases, presets
# ---------------------------------------------------------------------------

@router.get("/models")
async def list_models(kind: str | None = None):
    sql = "SELECT * FROM models"
    params: list = []
    if kind:
        sql += " WHERE kind = ?"
        params.append(kind)
    rows = db.query(sql + " ORDER BY provider, base_model_id, route", params)
    usage_rows = {r["m"]: r for r in db.query(
        "SELECT resolved_model AS m, COUNT(*) AS requests, SUM(cost_usd) AS cost FROM requests WHERE ts >= ?"
        " GROUP BY resolved_model", (auth.month_start(),))}
    aliases = db.query("SELECT name, targets FROM aliases")
    alias_map: dict[str, list[str]] = {}
    for a in aliases:
        for t in db.jload(a["targets"], []):
            alias_map.setdefault(t, []).append(a["name"])
    for r in rows:
        r["input_modalities"] = db.jload(r["input_modalities"], [])
        r["output_modalities"] = db.jload(r["output_modalities"], [])
        r["price"] = pricing.price_summary(r["id"])
        r["aliases"] = alias_map.get(r["id"], [])
        u = usage_rows.get(r["id"]) or {}
        r["month_requests"] = u.get("requests", 0)
        r["month_cost"] = round(u.get("cost") or 0, 6)
    return {"data": rows, "synced_at": settings.get("catalog_synced_at"), "region": settings.get("aws_region")}


@router.post("/models/sync")
async def sync_models():
    try:
        return await run_in_threadpool(catalog.sync_from_aws)
    except GatewayError:
        raise
    except Exception as e:  # noqa: BLE001
        raise from_aws(e) from e


@router.post("/models/bulk")
async def bulk_models(request: Request):
    body = await read_json(request)
    ids = body.get("ids") or []
    if not ids:
        raise bad_request("ids is required.")
    db.execute(f"UPDATE models SET enabled = ? WHERE id IN ({','.join('?' * len(ids))})",
               (int(bool(body.get("enabled"))), *ids))
    return {"updated": len(ids)}


@router.post("/models/custom")
async def add_custom_model(request: Request):
    body = await read_json(request)
    mid = (body.get("id") or "").strip()
    if not mid:
        raise bad_request("id is required (a Bedrock model id, inference profile id or ARN).")
    kind = body.get("kind") or "chat"
    db.execute(
        "INSERT OR REPLACE INTO models(id, base_model_id, name, provider, kind, input_modalities, output_modalities,"
        " streaming, route, lifecycle, enabled, source, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (mid, pricing.strip_region_prefix(mid), body.get("name") or mid,
         body.get("provider") or pricing.strip_region_prefix(mid).split(".")[0], kind,
         db.jdump(body.get("input_modalities") or ["TEXT"]), db.jdump(body.get("output_modalities") or ["TEXT"]),
         1, "custom", "ACTIVE", 1, "custom", time.time()))
    return catalog.get_model(mid)


@router.get("/models/availability")
async def model_availability(id: str):  # noqa: A002
    def run():
        base = pricing.strip_region_prefix(id)
        r = aws.client("bedrock").get_foundation_model_availability(modelId=base)
        r.pop("ResponseMetadata", None)
        return r
    try:
        return await run_in_threadpool(run)
    except Exception as e:  # noqa: BLE001
        raise from_aws(e, id) from e


@router.patch("/models")
async def update_model(request: Request):
    body = await read_json(request)
    mid = body.get("id")
    if not mid:
        raise bad_request("id is required.")
    if "enabled" in body:
        db.execute("UPDATE models SET enabled = ? WHERE id = ?", (int(bool(body["enabled"])), mid))
    if "name" in body:
        db.execute("UPDATE models SET name = ? WHERE id = ?", (body["name"], mid))
    if "kind" in body:
        db.execute("UPDATE models SET kind = ? WHERE id = ?", (body["kind"], mid))
    m = catalog.get_model(mid)
    if not m:
        raise GatewayError(404, "Model not found.", code="not_found")
    return m


@router.delete("/models")
async def delete_model(id: str):  # noqa: A002
    if db.execute("DELETE FROM models WHERE id = ? AND source = 'custom'", (id,)) == 0:
        raise bad_request("Only custom models can be deleted (disable synced models instead).")
    return {"deleted": True}


@router.get("/aliases")
async def list_aliases():
    rows = db.query("SELECT * FROM aliases ORDER BY name")
    for r in rows:
        r["targets"] = db.jload(r["targets"], [])
    return {"data": rows}


@router.put("/aliases/{name}")
async def put_alias(name: str, request: Request):
    body = await read_json(request)
    targets = [t for t in (body.get("targets") or []) if t]
    if not targets:
        raise bad_request("targets must list at least one model id (first = primary, rest = fallbacks).")
    if name.startswith("preset/") or "/" in name and not name.startswith("polly/"):
        raise bad_request("Alias names cannot contain '/'.")
    for t in targets:
        if db.one("SELECT name FROM aliases WHERE name = ?", (t,)):
            raise bad_request(f"Target `{t}` is itself an alias; point to model ids.")
    existing = db.one("SELECT created_at FROM aliases WHERE name = ?", (name,))
    db.execute("INSERT OR REPLACE INTO aliases(name, targets, description, created_at) VALUES(?,?,?,?)",
               (name, db.jdump(targets), body.get("description"), existing["created_at"] if existing else time.time()))
    return {"name": name, "targets": targets, "description": body.get("description")}


@router.delete("/aliases/{name}")
async def delete_alias(name: str):
    db.execute("DELETE FROM aliases WHERE name = ?", (name,))
    return {"deleted": True}


@router.post("/aliases/reset-defaults")
async def reset_aliases():
    return {"created": catalog.seed_default_aliases(force=True)}


@router.get("/presets")
async def list_presets():
    rows = db.query("SELECT * FROM presets ORDER BY name")
    for r in rows:
        r["params"] = db.jload(r["params"], {})
    return {"data": rows}


@router.put("/presets/{name}")
async def put_preset(name: str, request: Request):
    body = await read_json(request)
    if not body.get("model"):
        raise bad_request("model is required.")
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise bad_request("params must be an object.")
    now = time.time()
    existing = db.one("SELECT created_at FROM presets WHERE name = ?", (name,))
    db.execute("INSERT OR REPLACE INTO presets(name, model, system_prompt, params, description, created_at, updated_at)"
               " VALUES(?,?,?,?,?,?,?)", (name, body["model"], body.get("system_prompt"), db.jdump(params),
                                           body.get("description"), existing["created_at"] if existing else now, now))
    return catalog.get_preset(name)


@router.delete("/presets/{name}")
async def delete_preset(name: str):
    db.execute("DELETE FROM presets WHERE name = ?", (name,))
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------

@router.get("/prices")
async def list_prices():
    return {"data": db.query("SELECT * FROM prices ORDER BY model_prefix"),
            "geo_profile_markup": settings.get("geo_profile_markup")}


@router.put("/prices")
async def put_price(request: Request):
    body = await read_json(request)
    prefix = (body.get("model_prefix") or "").strip()
    if not prefix:
        raise bad_request("model_prefix is required.")
    fields = ["input_per_m", "output_per_m", "cache_read_per_m", "cache_write_per_m", "per_image",
              "per_1k_queries", "per_1m_chars", "per_minute"]
    vals = {f: (None if body.get(f) in ("", None) else float(body[f])) for f in fields}
    vals["input_per_m"] = vals["input_per_m"] or 0
    vals["output_per_m"] = vals["output_per_m"] or 0
    db.execute(
        "INSERT OR REPLACE INTO prices(model_prefix, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m,"
        " per_image, per_1k_queries, per_1m_chars, per_minute, geo_markup, custom, updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,1,?)",
        (prefix, *[vals[f] for f in fields], int(bool(body.get("geo_markup"))), time.time()))
    pricing.invalidate()
    return db.one("SELECT * FROM prices WHERE model_prefix = ?", (prefix,))


@router.delete("/prices")
async def delete_price(prefix: str):
    db.execute("DELETE FROM prices WHERE model_prefix = ?", (prefix,))
    pricing.invalidate()
    return {"deleted": True}


@router.post("/prices/reset")
async def reset_prices():
    pricing.seed_defaults(overwrite=True)
    return {"ok": True}


@router.post("/prices/recalculate")
async def recalc_costs(request: Request):
    """Re-price logged requests (e.g. after correcting a price). Optional body: {days}."""
    body = await read_json(request)
    since = time.time() - float(body.get("days") or 31) * 86400
    rows = db.query("SELECT id, resolved_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
                    " units, endpoint, cached FROM requests WHERE ts >= ? AND status < 400", (since,))
    updates = []
    for r in rows:
        if r["cached"] or not r["resolved_model"]:
            continue
        u = pricing.Usage(input_tokens=r["input_tokens"], output_tokens=r["output_tokens"],
                          cache_read_tokens=r["cache_read_tokens"], cache_write_tokens=r["cache_write_tokens"])
        if r["endpoint"] == "images.generations":
            u.images = int(r["units"])
        elif r["endpoint"] == "rerank":
            u.queries = int(r["units"])
        elif r["endpoint"] == "audio.speech":
            u.characters = int(r["units"])
        elif r["endpoint"] == "audio.transcriptions" and r["resolved_model"] == "aws-transcribe":
            u.minutes = float(r["units"])
        updates.append((pricing.cost(r["resolved_model"], u), r["id"]))
    db.executemany("UPDATE requests SET cost_usd = ? WHERE id = ?", updates)
    return {"updated": len(updates)}


# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

def _log_filters(params: dict) -> tuple[str, list]:
    where, args = [], []
    if params.get("key_id") not in (None, ""):
        where.append("key_id = ?")
        args.append(int(params["key_id"]))
    if params.get("model"):
        where.append("(resolved_model = ? OR requested_model = ?)")
        args += [params["model"], params["model"]]
    if params.get("endpoint"):
        where.append("endpoint = ?")
        args.append(params["endpoint"])
    if params.get("status") == "error":
        where.append("status >= 400")
    elif params.get("status") == "ok":
        where.append("status < 400")
    if params.get("session_id"):
        where.append("session_id = ?")
        args.append(params["session_id"])
    if params.get("since"):
        where.append("ts >= ?")
        args.append(float(params["since"]))
    if params.get("until"):
        where.append("ts <= ?")
        args.append(float(params["until"]))
    if params.get("q"):
        q = f"%{params['q']}%"
        where.append("(id LIKE ? OR requested_model LIKE ? OR resolved_model LIKE ? OR error_message LIKE ?"
                     " OR request_body LIKE ?)")
        args += [q, q, q, q, q]
    return (" WHERE " + " AND ".join(where)) if where else "", args


@router.get("/logs")
async def list_logs(request: Request, limit: int = 50, offset: int = 0):
    params = dict(request.query_params)
    w, args = _log_filters(params)
    limit = max(1, min(500, limit))
    rows = db.query(
        "SELECT id, ts, key_id, key_name, endpoint, requested_model, resolved_model, attempt, stream, status,"
        " error_code, error_message, ttft_ms, latency_ms, input_tokens, output_tokens, cache_read_tokens,"
        " cache_write_tokens, units, cost_usd, cached, finish_reason, session_id FROM requests"
        + w + " ORDER BY ts DESC LIMIT ? OFFSET ?", (*args, limit, offset))
    total = db.scalar("SELECT COUNT(*) FROM requests" + w, args)
    agg = db.one("SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS input_tokens,"
                 " COALESCE(SUM(output_tokens),0) AS output_tokens FROM requests" + w, args)
    return {"data": rows, "total": total, "aggregate": agg, "limit": limit, "offset": offset}


@router.get("/logs/export")
async def export_logs(request: Request):
    params = dict(request.query_params)
    w, args = _log_filters(params)

    def gen():
        offset = 0
        while True:
            rows = db.query("SELECT * FROM requests" + w + " ORDER BY ts LIMIT 500 OFFSET ?", (*args, offset))
            if not rows:
                break
            for r in rows:
                r["request_body"] = db.jload(r["request_body"], r["request_body"])
                r["response_body"] = db.jload(r["response_body"], r["response_body"])
                yield json.dumps(r, ensure_ascii=False) + "\n"
            offset += 500

    fname = f"portal-logs-{datetime.now().strftime('%Y%m%d-%H%M')}.jsonl"
    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.get("/logs/{log_id}")
async def get_log(log_id: str):
    r = db.one("SELECT * FROM requests WHERE id = ?", (log_id,))
    if not r:
        raise GatewayError(404, "Log entry not found.", code="not_found")
    r["request_body"] = db.jload(r["request_body"], r["request_body"])
    r["response_body"] = db.jload(r["response_body"], r["response_body"])
    return r


@router.delete("/logs")
async def purge_logs(older_than_days: float = 0):
    if older_than_days <= 0:
        n = db.execute("DELETE FROM requests")
    else:
        n = db.execute("DELETE FROM requests WHERE ts < ?", (time.time() - older_than_days * 86400,))
    return {"deleted": n}


# ---------------------------------------------------------------------------
# Billing
# ---------------------------------------------------------------------------

def _estimated() -> dict:
    month = auth.month_start()
    prev = auth.month_start(month - 86400)
    rows = db.query("SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS date, SUM(cost_usd) AS cost, COUNT(*) AS requests"
                    " FROM requests WHERE ts >= ? GROUP BY date ORDER BY date", (prev,))
    return {
        "month_to_date": round(float(db.scalar("SELECT COALESCE(SUM(cost_usd),0) FROM requests WHERE ts >= ?",
                                               (month,)) or 0), 6),
        "last_month": round(float(db.scalar("SELECT COALESCE(SUM(cost_usd),0) FROM requests WHERE ts >= ? AND ts < ?",
                                            (prev, month)) or 0), 6),
        "daily": [{"date": r["date"], "cost": round(r["cost"] or 0, 6), "requests": r["requests"]} for r in rows],
    }


@router.get("/billing")
async def get_billing():
    cached = db.one("SELECT value, fetched_at FROM billing_cache WHERE key = 'summary'")
    aws_part = None
    if cached:
        aws_part = db.jload(cached["value"], {})
        aws_part["fetched_at"] = cached["fetched_at"]
    return {"estimated": _estimated(), "aws": aws_part, "billing_enabled": settings.get("billing_enabled")}


@router.post("/billing/refresh")
async def refresh_billing():
    try:
        data = await run_in_threadpool(billing.fetch, True)
    except Exception as e:  # noqa: BLE001
        raise from_aws(e) from e
    return {"estimated": _estimated(), "aws": data, "billing_enabled": settings.get("billing_enabled")}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

EDITABLE = set(settings.DEFAULTS) - {"admin_password_hash", "admin_secret", "catalog_synced_at"}


@router.get("/settings")
async def get_settings():
    return settings.public_view()


@router.put("/settings")
async def put_settings(request: Request):
    body = await read_json(request)
    vals = {k: v for k, v in body.items() if k in EDITABLE}
    if "aws_secret_access_key" in vals and not vals["aws_secret_access_key"]:
        vals.pop("aws_secret_access_key")  # empty = keep the stored secret
    if "aws_auth_mode" in vals and vals["aws_auth_mode"] not in ("assume_role", "default_chain", "static_keys"):
        raise bad_request("aws_auth_mode must be assume_role, default_chain or static_keys.")
    for f in ("monthly_budget_usd",):
        if f in vals and vals[f] in ("", 0):
            vals[f] = None
    settings.set_many(vals)
    if any(k.startswith("aws_") for k in vals):
        aws.reset()
    if "transcribe_s3_bucket" in vals:
        catalog.ensure_virtual_models()
        db.execute("UPDATE models SET enabled = ? WHERE id = 'aws-transcribe'", (int(bool(vals["transcribe_s3_bucket"])),))
    return settings.public_view()


@router.post("/settings/test-aws")
async def test_aws():
    def run():
        out: dict[str, Any] = {"mode": settings.get("aws_auth_mode"), "region": settings.get("aws_region")}
        aws.reset()
        ident = aws.client("sts").get_caller_identity()
        out["identity"] = {"account": ident["Account"], "arn": ident["Arn"]}
        models = aws.client("bedrock").list_foundation_models().get("modelSummaries", [])
        out["foundation_models"] = len(models)
        checks = {}
        for name, fn in {
            "inference_profiles": lambda: aws.client("bedrock").list_inference_profiles(maxResults=1),
            "polly": lambda: aws.client("polly").describe_voices(Engine="neural", LanguageCode="en-US"),
            "cost_explorer": lambda: aws.client("ce", region="us-east-1").get_dimension_values(
                TimePeriod={"Start": (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d"),
                            "End": datetime.now(timezone.utc).strftime("%Y-%m-%d")},
                Dimension="SERVICE", SearchString="Bedrock"),
        }.items():
            try:
                fn()
                checks[name] = "ok"
            except Exception as e:  # noqa: BLE001
                checks[name] = f"{aws.error_code(e)}: {aws.error_message(e)[:200]}"
        out["checks"] = checks
        return out
    try:
        return await run_in_threadpool(run)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{aws.error_code(e)}: {aws.error_message(e)}",
                "mode": settings.get("aws_auth_mode"), "region": settings.get("aws_region")}


@router.get("/settings/iam")
async def iam_policies():
    ext = settings.get("aws_external_id")
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::<SOURCE_ACCOUNT_ID>:root"},
        "Action": "sts:AssumeRole", "Condition": {"StringEquals": {"sts:ExternalId": ext}}}]}
    tpl = config.INFRA_DIR / "bedrock-portal-role.yaml"
    return {"external_id": ext, "trust_policy": trust, "permissions_policy": PERMISSIONS_POLICY,
            "cloudformation_template": "infra/bedrock-portal-role.yaml",
            "cloudformation_yaml": tpl.read_text() if tpl.exists() else None}


@router.post("/cache/clear")
async def clear_cache():
    return {"deleted": db.execute("DELETE FROM response_cache")}


@router.get("/info")
async def info(request: Request):
    base = (settings.get("public_base_url") or str(request.base_url)).rstrip("/")
    return {"version": __version__, "base_url": base, "openai_base_url": base + "/v1",
            "anthropic_base_url": base, "region": settings.get("aws_region"),
            "aliases": [a["name"] for a in db.query("SELECT name FROM aliases ORDER BY name")]}


PERMISSIONS_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {"Sid": "InvokeModels", "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:*:inference-profile/*",
                      "arn:aws:bedrock:*:*:application-inference-profile/*", "arn:aws:bedrock:::foundation-model/*"]},
        {"Sid": "Catalog", "Effect": "Allow",
         "Action": ["bedrock:ListFoundationModels", "bedrock:GetFoundationModel",
                    "bedrock:GetFoundationModelAvailability", "bedrock:ListInferenceProfiles",
                    "bedrock:GetInferenceProfile", "bedrock:CountTokens", "bedrock:Rerank",
                    "bedrock:ApplyGuardrail", "bedrock:GetUseCaseForModelAccess"],
         "Resource": "*"},
        {"Sid": "MarketplaceFirstUse", "Effect": "Allow",
         "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"], "Resource": "*"},
        {"Sid": "Voice", "Effect": "Allow",
         "Action": ["polly:SynthesizeSpeech", "polly:DescribeVoices", "transcribe:StartTranscriptionJob",
                    "transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"], "Resource": "*"},
        {"Sid": "Billing", "Effect": "Allow",
         "Action": ["ce:GetCostAndUsage", "ce:GetDimensionValues", "billing:GetCredits"], "Resource": "*"},
        {"Sid": "Identity", "Effect": "Allow", "Action": ["sts:GetCallerIdentity"], "Resource": "*"},
    ],
}
