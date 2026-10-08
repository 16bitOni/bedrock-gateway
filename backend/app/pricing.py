"""Price table and cost calculation.

Prices are USD, on-demand Standard tier, keyed by a *prefix* of the base model id
(region/geo prefixes like `us.` or `global.` are stripped before matching, and the
longest matching prefix wins). Defaults below were compiled in Oct 2026 from the
AWS pricing page, Anthropic's list prices and LiteLLM's price map; every row is
editable in the dashboard (Settings → Pricing) and edits survive "reset defaults".
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass

from . import db, settings

# prefix: (input/1M, output/1M, cache_read/1M, cache_write/1M, geo_markup)
TOKEN_PRICES: dict[str, tuple[float, float, float | None, float | None, bool]] = {
    # Anthropic (global. price; geo/in-region profiles +10% via geo_markup)
    "anthropic.claude-fable-5-1": (10.00, 50.00, 0.25, 12.50, True),
    "anthropic.claude-mythos-5-1": (10.00, 50.00, 0.25, 12.50, True),
    "anthropic.claude-opus-5-5": (4.00, 20.00, 0.20, 5.00, True),
    "anthropic.claude-opus-5": (5.00, 25.00, 0.50, 6.25, True),
    "anthropic.claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50, True),
    "anthropic.claude-sonnet-5": (2.00, 10.00, 0.20, 2.50, True),
    "anthropic.claude-opus-4-8": (5.00, 25.00, 0.50, 6.25, True),
    "anthropic.claude-opus-4-7": (5.00, 25.00, 0.50, 6.25, True),
    "anthropic.claude-opus-4-6": (5.00, 25.00, 0.50, 6.25, True),
    "anthropic.claude-opus-4-5": (5.00, 25.00, 0.50, 6.25, True),
    "anthropic.claude-opus-4-1": (15.00, 75.00, 1.50, 18.75, False),
    "anthropic.claude-opus-4": (15.00, 75.00, 1.50, 18.75, False),
    "anthropic.claude-sonnet-4-6": (3.00, 15.00, 0.30, 3.75, True),
    "anthropic.claude-sonnet-4-5": (3.00, 15.00, 0.30, 3.75, True),
    "anthropic.claude-sonnet-4": (3.00, 15.00, 0.30, 3.75, False),
    "anthropic.claude-3-7-sonnet": (3.00, 15.00, 0.30, 3.75, False),
    "anthropic.claude-haiku-4-5": (1.00, 5.00, 0.10, 1.25, True),
    "anthropic.claude-3-5-haiku": (0.80, 4.00, 0.08, 1.00, False),
    "anthropic.claude-3-haiku": (0.25, 1.25, None, None, False),
    # Amazon Nova
    "amazon.nova-2-lite": (0.30, 2.50, 0.075, None, True),
    "amazon.nova-2-pro": (2.19, 17.50, None, None, True),
    "amazon.nova-premier": (2.50, 12.50, 0.625, None, False),
    "amazon.nova-pro": (0.80, 3.20, 0.20, None, False),
    "amazon.nova-lite": (0.06, 0.24, 0.015, None, False),
    "amazon.nova-micro": (0.035, 0.14, 0.00875, None, False),
    "amazon.nova-2-sonic": (0.33, 2.75, None, None, False),
    "amazon.nova-sonic": (3.40, 13.60, None, None, False),
    # Meta
    "meta.llama4-maverick": (0.24, 0.97, None, None, False),
    "meta.llama4-scout": (0.17, 0.66, None, None, False),
    "meta.llama3-3-70b": (0.72, 0.72, None, None, False),
    "meta.llama3-2-90b": (0.72, 0.72, None, None, False),
    "meta.llama3-2-11b": (0.16, 0.16, None, None, False),
    "meta.llama3-2-3b": (0.15, 0.15, None, None, False),
    "meta.llama3-2-1b": (0.10, 0.10, None, None, False),
    "meta.llama3-1-405b": (2.40, 2.40, None, None, False),
    "meta.llama3-1-70b": (0.72, 0.72, None, None, False),
    "meta.llama3-1-8b": (0.22, 0.22, None, None, False),
    # Mistral
    "mistral.mistral-large-3": (0.50, 1.50, None, None, False),
    "mistral.magistral-small": (0.50, 1.50, None, None, False),
    "mistral.devstral-2": (0.40, 2.00, None, None, False),
    "mistral.pixtral-large": (2.00, 6.00, None, None, False),
    "mistral.mistral-large-2407": (2.00, 6.00, None, None, False),
    "mistral.mistral-small": (0.10, 0.30, None, None, False),
    "mistral.voxtral-small": (0.10, 0.30, None, None, False),
    "mistral.voxtral-mini": (0.04, 0.04, None, None, False),
    "mistral.ministral": (0.10, 0.10, None, None, False),
    # DeepSeek
    "deepseek.v3.2": (0.62, 1.85, None, None, False),
    "deepseek.v3": (0.58, 1.68, None, None, False),
    "deepseek.r1": (1.35, 5.40, None, None, False),
    # OpenAI
    "openai.gpt-oss-120b": (0.15, 0.60, None, None, False),
    "openai.gpt-oss-20b": (0.07, 0.30, None, None, False),
    "openai.gpt-6-sol": (2.00, 10.00, None, None, True),
    "openai.gpt-6-luna": (0.10, 0.50, None, None, True),
    "openai.gpt-6-astra": (10.00, 50.00, None, None, True),
    "openai.gpt-5.6-sol": (4.00, 20.00, None, None, True),
    "openai.gpt-5.6-terra": (2.00, 12.00, None, None, True),
    "openai.gpt-5.6-luna": (0.20, 1.20, None, None, True),
    # Qwen
    "qwen.qwen3-coder-480b": (0.45, 1.80, None, None, False),
    "qwen.qwen3-235b": (0.22, 0.88, None, None, False),
    "qwen.qwen3-next-80b": (0.15, 1.20, None, None, False),
    "qwen.qwen3-vl-235b": (0.53, 2.66, None, None, False),
    "qwen.qwen3-32b": (0.15, 0.60, None, None, False),
    # Others
    "moonshotai.kimi-k3": (3.00, 15.00, None, None, False),
    "zai.glm-5": (1.00, 3.20, None, None, False),
    "minimax.minimax-m2.5": (0.30, 1.20, None, None, False),
    "xai.grok-4.6": (2.00, 6.00, None, None, False),
    "google.gemma-3-27b": (0.23, 0.38, None, None, False),
    "cohere.command-r-plus": (3.00, 15.00, None, None, False),
    "cohere.command-r": (0.50, 1.50, None, None, False),
    # Embeddings (input only)
    "amazon.titan-embed-text-v2": (0.02, 0.0, None, None, False),
    "amazon.titan-embed-text-v1": (0.10, 0.0, None, None, False),
    "amazon.titan-embed-image": (0.80, 0.0, None, None, False),
    "amazon.nova-2-multimodal-embeddings": (0.135, 0.0, None, None, False),
    "cohere.embed-v4": (0.12, 0.0, None, None, False),
    "cohere.embed-english-v3": (0.10, 0.0, None, None, False),
    "cohere.embed-multilingual-v3": (0.10, 0.0, None, None, False),
}

IMAGE_PRICES: dict[str, float] = {
    "amazon.nova-canvas": 0.04,          # standard ≤1024²; premium/larger is computed below
    "amazon.titan-image-generator-v2": 0.008,
    "amazon.titan-image-generator-v1": 0.008,
    "stability.stable-image-ultra": 0.14,
    "stability.sd3-5-large": 0.08,
    "stability.stable-image-core": 0.04,
    "stability.stable-diffusion-3-5-large": 0.08,
}

QUERY_PRICES: dict[str, float] = {
    "cohere.rerank-v3-5": 2.00,
    "amazon.rerank-v1": 1.00,
}

CHAR_PRICES: dict[str, float] = {  # Amazon Polly, per 1M characters
    "polly/standard": 4.00,
    "polly/neural": 16.00,
    "polly/generative": 30.00,
    "polly/long-form": 100.00,
}

MINUTE_PRICES: dict[str, float] = {
    "aws-transcribe": 0.024,
}

GEO_PREFIXES = ("us.", "eu.", "apac.", "jp.", "au.", "ca.", "in.", "us-gov.", "global.")
_PREFIX_RE = re.compile(r"^(us|eu|apac|jp|au|ca|in|us-gov|global)\.")


def strip_region_prefix(model_id: str) -> str:
    """`global.anthropic.claude-x` → `anthropic.claude-x`; ARNs → the underlying model id."""
    mid = model_id
    if mid.startswith("arn:"):
        if ":application-inference-profile/" in mid:
            r = db.one("SELECT base_model_id FROM models WHERE id = ?", (mid,))
            if r and r["base_model_id"] and not r["base_model_id"].startswith("arn:"):
                return _PREFIX_RE.sub("", r["base_model_id"])
        mid = mid.rsplit("/", 1)[-1]
    return _PREFIX_RE.sub("", mid)


def region_scope(model_id: str) -> str:
    m = _PREFIX_RE.match(model_id)
    if not m:
        return "in_region"
    return "global" if m.group(1) == "global" else "geo"


def default_rows() -> list[dict]:
    now = time.time()
    rows: list[dict] = []
    for prefix, (i, o, cr, cw, geo) in TOKEN_PRICES.items():
        rows.append(dict(model_prefix=prefix, input_per_m=i, output_per_m=o, cache_read_per_m=cr,
                         cache_write_per_m=cw, per_image=None, per_1k_queries=None, per_1m_chars=None,
                         per_minute=None, geo_markup=int(geo), custom=0, updated_at=now))
    for prefix, p in IMAGE_PRICES.items():
        rows.append(dict(model_prefix=prefix, input_per_m=0, output_per_m=0, cache_read_per_m=None,
                         cache_write_per_m=None, per_image=p, per_1k_queries=None, per_1m_chars=None,
                         per_minute=None, geo_markup=0, custom=0, updated_at=now))
    for prefix, p in QUERY_PRICES.items():
        rows.append(dict(model_prefix=prefix, input_per_m=0, output_per_m=0, cache_read_per_m=None,
                         cache_write_per_m=None, per_image=None, per_1k_queries=p, per_1m_chars=None,
                         per_minute=None, geo_markup=0, custom=0, updated_at=now))
    for prefix, p in CHAR_PRICES.items():
        rows.append(dict(model_prefix=prefix, input_per_m=0, output_per_m=0, cache_read_per_m=None,
                         cache_write_per_m=None, per_image=None, per_1k_queries=None, per_1m_chars=p,
                         per_minute=None, geo_markup=0, custom=0, updated_at=now))
    for prefix, p in MINUTE_PRICES.items():
        rows.append(dict(model_prefix=prefix, input_per_m=0, output_per_m=0, cache_read_per_m=None,
                         cache_write_per_m=None, per_image=None, per_1k_queries=None, per_1m_chars=None,
                         per_minute=p, geo_markup=0, custom=0, updated_at=now))
    return rows


_COLS = ["model_prefix", "input_per_m", "output_per_m", "cache_read_per_m", "cache_write_per_m",
         "per_image", "per_1k_queries", "per_1m_chars", "per_minute", "geo_markup", "custom", "updated_at"]


def seed_defaults(overwrite: bool = False) -> None:
    """Insert default prices. With overwrite=True, resets every non-custom row."""
    rows = default_rows()
    placeholders = ",".join("?" for _ in _COLS)
    if overwrite:
        sql = (f"INSERT INTO prices({','.join(_COLS)}) VALUES({placeholders}) "
               "ON CONFLICT(model_prefix) DO UPDATE SET " +
               ", ".join(f"{c}=excluded.{c}" for c in _COLS if c != "model_prefix") +
               " WHERE prices.custom = 0")
    else:
        sql = f"INSERT OR IGNORE INTO prices({','.join(_COLS)}) VALUES({placeholders})"
    db.executemany(sql, [[r[c] for c in _COLS] for r in rows])
    invalidate()


_cache: list[dict] | None = None
_lock = threading.Lock()


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def _rows() -> list[dict]:
    global _cache
    with _lock:
        if _cache is None:
            _cache = sorted(db.query("SELECT * FROM prices"), key=lambda r: -len(r["model_prefix"]))
        return _cache


def lookup(model_id: str) -> dict | None:
    base = strip_region_prefix(model_id)
    for row in _rows():
        if base.startswith(row["model_prefix"]) or model_id.startswith(row["model_prefix"]):
            return row
    return None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    images: int = 0
    image_multiplier: float = 1.0
    queries: int = 0
    characters: int = 0
    minutes: float = 0.0


def cost(model_id: str, u: Usage) -> float:
    row = lookup(model_id)
    if not row:
        return 0.0
    total = 0.0
    total += u.input_tokens * (row["input_per_m"] or 0) / 1e6
    total += u.output_tokens * (row["output_per_m"] or 0) / 1e6
    cr = row["cache_read_per_m"] if row["cache_read_per_m"] is not None else (row["input_per_m"] or 0) * 0.1
    cw = row["cache_write_per_m"] if row["cache_write_per_m"] is not None else (row["input_per_m"] or 0) * 1.25
    total += u.cache_read_tokens * cr / 1e6
    total += u.cache_write_tokens * cw / 1e6
    if u.images and row["per_image"]:
        total += u.images * row["per_image"] * u.image_multiplier
    if u.queries and row["per_1k_queries"]:
        total += u.queries * row["per_1k_queries"] / 1000
    if u.characters and row["per_1m_chars"]:
        total += u.characters * row["per_1m_chars"] / 1e6
    if u.minutes and row["per_minute"]:
        total += u.minutes * row["per_minute"]
    if row["geo_markup"] and region_scope(model_id) != "global":
        total *= float(settings.get("geo_profile_markup") or 1.0)
    return round(total, 8)


def price_summary(model_id: str) -> dict | None:
    row = lookup(model_id)
    if not row:
        return None
    mult = 1.0
    if row["geo_markup"] and region_scope(model_id) != "global":
        mult = float(settings.get("geo_profile_markup") or 1.0)

    def m(v):
        return None if v is None else round(v * mult, 6)

    return {
        "matched_prefix": row["model_prefix"],
        "input_per_m": m(row["input_per_m"]),
        "output_per_m": m(row["output_per_m"]),
        "cache_read_per_m": m(row["cache_read_per_m"]),
        "cache_write_per_m": m(row["cache_write_per_m"]),
        "per_image": row["per_image"],
        "per_1k_queries": row["per_1k_queries"],
        "per_1m_chars": row["per_1m_chars"],
        "per_minute": row["per_minute"],
        "markup_applied": mult != 1.0,
    }
