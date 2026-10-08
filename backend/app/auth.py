"""API keys (for your projects) and admin sessions (for the dashboard)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from fastapi import Request

from . import config, db, settings
from .errors import GatewayError

KEY_PREFIX = "sk-portal-"
PLAYGROUND_KEY = {"id": 0, "name": "Playground", "allowed_models": [], "monthly_budget_usd": None,
                  "rpm_limit": None, "store_bodies": 1, "cache_enabled": 0, "guardrail_id": None,
                  "guardrail_version": None, "is_admin": True}


# ---------------------------------------------------------------------------
# Password hashing (stdlib scrypt)
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, digest_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(digest, expected)
    except Exception:  # noqa: BLE001
        return False


def bootstrap_admin() -> None:
    if config.ADMIN_PASSWORD and not settings.get("admin_password_hash"):
        settings.set("admin_password_hash", hash_password(config.ADMIN_PASSWORD))


# ---------------------------------------------------------------------------
# Admin session tokens: "adm.<expiry>.<hmac>"
# ---------------------------------------------------------------------------

ADMIN_TOKEN_TTL = 30 * 24 * 3600


def _sign(payload: str) -> str:
    secret = (settings.get("admin_secret") or "").encode()
    pw = (settings.get("admin_password_hash") or "").encode()  # changing the password logs everyone out
    return hmac.new(secret + pw, payload.encode(), hashlib.sha256).hexdigest()


def issue_admin_token() -> str:
    exp = str(int(time.time()) + ADMIN_TOKEN_TTL)
    return f"adm.{exp}.{_sign(exp)}"


def is_admin_token(token: str) -> bool:
    if not token or not token.startswith("adm."):
        return False
    try:
        _, exp, sig = token.split(".")
    except ValueError:
        return False
    try:
        if int(exp) < time.time():
            return False
    except ValueError:
        return False
    return hmac.compare_digest(sig, _sign(exp))


def bearer(request: Request) -> str:
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return (request.headers.get("x-api-key") or request.headers.get("api-key") or "").strip()


def require_admin(request: Request) -> None:
    if not settings.get("admin_password_hash"):
        raise GatewayError(401, "Admin password not set yet. Open the dashboard to create one.",
                           type="authentication_error", code="setup_required")
    if not is_admin_token(bearer(request)):
        raise GatewayError(401, "Not signed in.", type="authentication_error", code="invalid_admin_token")


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------

def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def generate_key() -> tuple[str, str, str]:
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    return raw, hash_key(raw), raw[: len(KEY_PREFIX) + 6]


def _row_to_key(r: dict) -> dict:
    r = dict(r)
    r["allowed_models"] = db.jload(r.get("allowed_models"), [])
    r.pop("key_hash", None)
    return r


def get_key(key_id: int) -> dict | None:
    r = db.one("SELECT * FROM api_keys WHERE id = ?", (key_id,))
    return _row_to_key(r) if r else None


def month_start(ts: float | None = None) -> float:
    d = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return datetime(d.year, d.month, 1, tzinfo=timezone.utc).timestamp()


def month_spend(key_id: int | None = None) -> float:
    if key_id is None:
        return float(db.scalar("SELECT COALESCE(SUM(cost_usd),0) FROM requests WHERE ts >= ?", (month_start(),)) or 0)
    return float(db.scalar("SELECT COALESCE(SUM(cost_usd),0) FROM requests WHERE key_id = ? AND ts >= ?",
                           (key_id, month_start())) or 0)


class _RateLimiter:
    def __init__(self):
        self._hits: dict[int, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key_id: int, rpm: int) -> float | None:
        """Returns seconds to wait if over the limit, else None (and records the hit)."""
        now = time.time()
        with self._lock:
            q = self._hits[key_id]
            while q and q[0] <= now - 60:
                q.popleft()
            if len(q) >= rpm:
                return max(0.5, 60 - (now - q[0]))
            q.append(now)
            return None


rate_limiter = _RateLimiter()


def _money(v) -> str:
    v = float(v)
    return f"{v:.2f}" if v >= 1 else f"{v:.4f}".rstrip("0").rstrip(".")
_last_used_flush: dict[int, float] = {}


def authenticate(request: Request) -> dict:
    """FastAPI dependency for /v1/* endpoints. Returns the key record."""
    token = bearer(request)
    if not token:
        raise GatewayError(401, "Missing API key. Send `Authorization: Bearer sk-portal-...`.",
                           type="invalid_request_error", code="invalid_api_key")
    if is_admin_token(token):
        key = dict(PLAYGROUND_KEY)
    else:
        r = db.one("SELECT * FROM api_keys WHERE key_hash = ?", (hash_key(token),))
        if r is None:
            raise GatewayError(401, "Invalid API key.", type="invalid_request_error", code="invalid_api_key")
        key = _row_to_key(r)
        if key["disabled"]:
            raise GatewayError(403, f"API key `{key['name']}` is disabled.", type="permission_error",
                               code="key_disabled", headers={"x-should-retry": "false"})
        if key["expires_at"] and key["expires_at"] < time.time():
            raise GatewayError(403, f"API key `{key['name']}` has expired.", type="permission_error",
                               code="key_expired", headers={"x-should-retry": "false"})
        if key["rpm_limit"]:
            wait = rate_limiter.check(key["id"], int(key["rpm_limit"]))
            if wait is not None:
                raise GatewayError(429, f"Rate limit of {key['rpm_limit']} requests/minute reached for this key.",
                                   type="rate_limit_error", code="rate_limit_exceeded",
                                   headers={"retry-after": str(int(wait) + 1), "retry-after-ms": str(int(wait * 1000))})
        if key["monthly_budget_usd"] is not None and request.method != "GET":
            spent = month_spend(key["id"])
            if spent >= float(key["monthly_budget_usd"]):
                raise GatewayError(429, f"Monthly budget of ${_money(key['monthly_budget_usd'])} reached for key "
                                   f"`{key['name']}` (spent ${spent:.4f}).", type="insufficient_quota",
                                   code="insufficient_quota", headers={"x-should-retry": "false"})
        now = time.time()
        if now - _last_used_flush.get(key["id"], 0) > 30:
            _last_used_flush[key["id"]] = now
            db.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (now, key["id"]))
        key["is_admin"] = False

    global_cap = settings.get("monthly_budget_usd")
    if global_cap not in (None, "", 0) and request.method != "GET":
        spent = month_spend(None)
        if spent >= float(global_cap):
            raise GatewayError(429, f"Global monthly budget of ${_money(global_cap)} reached (spent ${spent:.4f}). "
                               "Raise it in Settings.", type="insufficient_quota", code="insufficient_quota",
                               headers={"x-should-retry": "false"})
    request.state.key = key
    return key
