"""Model catalog (synced from Bedrock), aliases, presets and model-name resolution."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from . import aws, db, pricing, settings
from .errors import GatewayError, model_not_found

VIRTUAL_MODELS = [
    # id, name, provider, kind, input, output
    ("polly/generative", "Amazon Polly – Generative voices", "Amazon", "speech", ["TEXT"], ["SPEECH"]),
    ("polly/neural", "Amazon Polly – Neural voices", "Amazon", "speech", ["TEXT"], ["SPEECH"]),
    ("polly/long-form", "Amazon Polly – Long-form voices", "Amazon", "speech", ["TEXT"], ["SPEECH"]),
    ("polly/standard", "Amazon Polly – Standard voices", "Amazon", "speech", ["TEXT"], ["SPEECH"]),
    ("aws-transcribe", "Amazon Transcribe (batch, needs S3 bucket)", "Amazon", "transcription", ["SPEECH"], ["TEXT"]),
]

# Friendly aliases created on first sync, pointing at the newest matching model.
# name: (description, [ordered regexes against base ids; first regex with a match wins])
DEFAULT_ALIASES: dict[str, tuple[str, list[str]]] = {
    "smart": ("Best general model (Claude Opus/Sonnet)", [r"anthropic\.claude-opus-\d", r"anthropic\.claude-sonnet-\d"]),
    "balanced": ("Strong + cheaper (Claude Sonnet)", [r"anthropic\.claude-sonnet-\d"]),
    "fast": ("Fast and cheap (Claude Haiku → Nova Lite)", [r"anthropic\.claude-haiku-\d", r"amazon\.nova-2-lite", r"amazon\.nova-lite"]),
    "cheap": ("Cheapest decent chat model", [r"amazon\.nova-2-lite", r"amazon\.nova-micro", r"openai\.gpt-oss-20b"]),
    "claude-opus": ("Latest Claude Opus", [r"anthropic\.claude-opus-\d"]),
    "claude-sonnet": ("Latest Claude Sonnet", [r"anthropic\.claude-sonnet-\d"]),
    "claude-haiku": ("Latest Claude Haiku", [r"anthropic\.claude-haiku-\d"]),
    "nova-lite": ("Amazon Nova Lite", [r"amazon\.nova-2-lite", r"amazon\.nova-lite"]),
    "nova-pro": ("Amazon Nova Pro", [r"amazon\.nova-2-pro", r"amazon\.nova-pro"]),
    "gpt-oss": ("OpenAI gpt-oss 120B", [r"openai\.gpt-oss-120b"]),
    "llama": ("Meta Llama (latest)", [r"meta\.llama4-maverick", r"meta\.llama3-3-70b"]),
    "deepseek": ("DeepSeek (latest)", [r"deepseek\.v3", r"deepseek\.r1"]),
    "coder": ("Coding model", [r"anthropic\.claude-sonnet-\d", r"qwen\.qwen3-coder", r"mistral\.devstral"]),
    "vision": ("Image understanding", [r"anthropic\.claude-sonnet-\d", r"amazon\.nova-2-lite", r"amazon\.nova-pro"]),
    "embed": ("Default text embeddings (Titan v2)", [r"amazon\.titan-embed-text-v2"]),
    "embed-multilingual": ("Cohere Embed (multilingual)", [r"cohere\.embed-v4", r"cohere\.embed-multilingual-v3"]),
    "image": ("Default image generation", [r"amazon\.nova-canvas", r"stability\.stable-image-core", r"amazon\.titan-image-generator-v2"]),
    "image-hq": ("High quality image generation", [r"stability\.stable-image-ultra", r"stability\.sd3-5-large", r"amazon\.nova-canvas"]),
    "rerank": ("Reranking", [r"cohere\.rerank-v3-5", r"amazon\.rerank-v1"]),
    "transcribe": ("Speech-to-text", [r"mistral\.voxtral-small", r"mistral\.voxtral-mini"]),
    # OpenAI names hard-coded in many tools/tutorials
    "gpt-4o": ("Compat: maps to Claude Sonnet", [r"anthropic\.claude-sonnet-\d"]),
    "gpt-4o-mini": ("Compat: maps to Claude Haiku", [r"anthropic\.claude-haiku-\d", r"amazon\.nova-2-lite"]),
    "gpt-4.1": ("Compat: maps to Claude Sonnet", [r"anthropic\.claude-sonnet-\d"]),
    "text-embedding-3-small": ("Compat: Titan v2 embeddings", [r"amazon\.titan-embed-text-v2"]),
    "text-embedding-3-large": ("Compat: Cohere Embed v4", [r"cohere\.embed-v4", r"amazon\.titan-embed-text-v2"]),
    "text-embedding-ada-002": ("Compat: Titan v2 embeddings", [r"amazon\.titan-embed-text-v2"]),
    "dall-e-3": ("Compat: Nova Canvas", [r"amazon\.nova-canvas", r"stability\.stable-image-core"]),
    "gpt-image-1": ("Compat: Nova Canvas", [r"amazon\.nova-canvas", r"stability\.stable-image-core"]),
    "whisper-1": ("Compat: speech-to-text", [r"mistral\.voxtral-mini", r"mistral\.voxtral-small"]),
}


def _kind(model_id: str, outputs: list[str], inputs: list[str]) -> str:
    mid = model_id.lower()
    if "rerank" in mid:
        return "rerank"
    if "embed" in mid or "EMBEDDING" in outputs:
        return "embedding"
    if "sonic" in mid or "SPEECH" in outputs:
        return "realtime"
    if "IMAGE" in outputs:
        return "image"
    if "VIDEO" in outputs:
        return "video"
    if "TEXT" in outputs:
        return "chat"
    return "other"


def _version_key(base_id: str) -> tuple:
    """Sort key so that newer model versions come first (larger numbers win)."""
    core = re.sub(r"-v\d+(:\d+)?$", "", base_id)
    date = re.search(r"-(\d{8})", core)
    core = re.sub(r"-\d{8}", "", core)
    nums = [int(n) for n in re.findall(r"\d+", core) if len(n) < 6]
    return (tuple(nums), int(date.group(1)) if date else 99999999)


def sync_from_aws() -> dict[str, Any]:
    """Pull foundation models + inference profiles from Bedrock into the catalog."""
    bedrock = aws.client("bedrock")
    fms = bedrock.list_foundation_models().get("modelSummaries", [])

    profiles: list[dict] = []
    for ptype in ("SYSTEM_DEFINED", "APPLICATION"):
        token = None
        while True:
            kwargs: dict[str, Any] = {"typeEquals": ptype, "maxResults": 1000}
            if token:
                kwargs["nextToken"] = token
            try:
                resp = bedrock.list_inference_profiles(**kwargs)
            except Exception:  # noqa: BLE001 - older regions / permissions
                break
            for p in resp.get("inferenceProfileSummaries", []):
                p["_type"] = ptype
                profiles.append(p)
            token = resp.get("nextToken")
            if not token:
                break

    by_base: dict[str, dict] = {m["modelId"]: m for m in fms}
    now = time.time()
    entries: dict[str, dict] = {}

    for m in fms:
        inputs = m.get("inputModalities", []) or []
        outputs = m.get("outputModalities", []) or []
        kind = _kind(m["modelId"], outputs, inputs)
        lifecycle = (m.get("modelLifecycle") or {}).get("status", "ACTIVE")
        if "ON_DEMAND" in (m.get("inferenceTypesSupported") or []):
            # Skip provisioned-only variants like "...:0:28k" context-specific ids
            if re.search(r":\d+k$|:mm$", m["modelId"]):
                continue
            entries[m["modelId"]] = dict(
                id=m["modelId"], base_model_id=m["modelId"], name=m.get("modelName") or m["modelId"],
                provider=m.get("providerName") or m["modelId"].split(".")[0], kind=kind,
                input_modalities=inputs, output_modalities=outputs,
                streaming=int(bool(m.get("responseStreamingSupported", True))), route="on_demand",
                lifecycle=lifecycle,
            )

    for p in profiles:
        pid = p["inferenceProfileId"] if p["_type"] == "SYSTEM_DEFINED" else p["inferenceProfileArn"]
        arns = [x.get("modelArn", "") for x in p.get("models", [])]
        base = arns[0].rsplit("/", 1)[-1] if arns else pricing.strip_region_prefix(pid)
        fm = by_base.get(base, {})
        inputs = fm.get("inputModalities", []) or ["TEXT"]
        outputs = fm.get("outputModalities", []) or ["TEXT"]
        if p["_type"] == "APPLICATION":
            route = "application_profile"
            name = f"{p.get('inferenceProfileName')} (app profile → {base})"
        else:
            route = "profile_global" if pid.startswith("global.") else "profile_geo"
            name = f"{fm.get('modelName') or base} ({pid.split('.')[0]})"
        entries[pid] = dict(
            id=pid, base_model_id=base, name=name,
            provider=fm.get("providerName") or base.split(".")[0],
            kind=_kind(base, outputs, inputs), input_modalities=inputs, output_modalities=outputs,
            streaming=int(bool(fm.get("responseStreamingSupported", True))), route=route,
            lifecycle=(fm.get("modelLifecycle") or {}).get("status", "ACTIVE"),
        )

    # Pick one preferred route per base model to enable by default.
    region = settings.get("aws_region") or "us-east-1"
    geo = {"us": "us.", "eu": "eu.", "ap": "apac.", "ca": "ca.", "sa": "us."}.get(region.split("-")[0], "us.")
    preferred: dict[str, str] = {}
    rank = {"profile_global": 0, "on_demand": 1, "profile_geo": 2, "application_profile": 3}
    for e in entries.values():
        cur = preferred.get(e["base_model_id"])
        score = (rank.get(e["route"], 9), 0 if e["id"].startswith(geo) else 1)
        if cur is None:
            preferred[e["base_model_id"]] = e["id"]
            continue
        c = entries[cur]
        cscore = (rank.get(c["route"], 9), 0 if c["id"].startswith(geo) else 1)
        if score < cscore:
            preferred[e["base_model_id"]] = e["id"]

    existing = {r["id"]: r for r in db.query("SELECT id, enabled, source FROM models")}
    rows = []
    for e in entries.values():
        usable_kind = e["kind"] in ("chat", "embedding", "image", "rerank")
        default_enabled = int(usable_kind and e["lifecycle"] == "ACTIVE" and preferred.get(e["base_model_id"]) == e["id"])
        if e["route"] == "application_profile":
            default_enabled = 1
        enabled = existing[e["id"]]["enabled"] if e["id"] in existing else default_enabled
        rows.append((e["id"], e["base_model_id"], e["name"], e["provider"], e["kind"],
                     db.jdump(e["input_modalities"]), db.jdump(e["output_modalities"]), e["streaming"],
                     e["route"], e["lifecycle"], enabled, "aws", now))

    with db.transaction() as c:
        c.execute("DELETE FROM models WHERE source = 'aws'")
        c.executemany(
            "INSERT OR REPLACE INTO models(id, base_model_id, name, provider, kind, input_modalities, "
            "output_modalities, streaming, route, lifecycle, enabled, source, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    ensure_virtual_models()
    settings.set("catalog_synced_at", now)
    created = seed_default_aliases()
    return {"models": len(rows), "enabled": sum(r[10] for r in rows), "aliases_created": created}


def ensure_virtual_models() -> None:
    now = time.time()
    existing = {r["id"]: r["enabled"] for r in db.query("SELECT id, enabled FROM models WHERE source='builtin'")}
    rows = []
    for mid, name, prov, kind, inp, out in VIRTUAL_MODELS:
        default = 1
        if mid == "aws-transcribe":
            default = 1 if settings.get("transcribe_s3_bucket") else 0
        rows.append((mid, mid, name, prov, kind, db.jdump(inp), db.jdump(out), 0, "virtual", "ACTIVE",
                     existing.get(mid, default), "builtin", now))
    db.executemany(
        "INSERT OR REPLACE INTO models(id, base_model_id, name, provider, kind, input_modalities, "
        "output_modalities, streaming, route, lifecycle, enabled, source, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )


def seed_default_aliases(force: bool = False) -> int:
    models = db.query("SELECT id, base_model_id, route, enabled, lifecycle FROM models WHERE source != 'builtin'")
    existing = {r["name"] for r in db.query("SELECT name FROM aliases")}
    created = 0
    now = time.time()
    for name, (desc, patterns) in DEFAULT_ALIASES.items():
        if name in existing and not force:
            continue
        targets: list[str] = []
        for pat in patterns:
            rx = re.compile(pat)
            cands = [m for m in models if rx.search(m["base_model_id"]) and m["lifecycle"] == "ACTIVE"]
            if not cands:
                continue
            # newest version first, enabled first, global profile first
            cands.sort(key=lambda m: (_version_key(m["base_model_id"]), m["enabled"],
                                      m["route"] == "profile_global", m["route"] == "on_demand"), reverse=True)
            pick = cands[0]["id"]
            if pick not in targets:
                targets.append(pick)
        if not targets:
            continue
        db.execute(
            "INSERT OR REPLACE INTO aliases(name, targets, description, created_at) VALUES(?,?,?,?)",
            (name, db.jdump(targets), desc, now),
        )
        db.execute(f"UPDATE models SET enabled = 1 WHERE id IN ({','.join('?' * len(targets))})", targets)
        created += 1
    return created


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

@dataclass
class Resolved:
    requested: str
    targets: list[str]                       # ordered fallback chain of Bedrock model ids
    preset: dict | None = None
    alias: str | None = None
    info: dict[str, dict] = field(default_factory=dict)

    @property
    def primary(self) -> str:
        return self.targets[0]


def get_model(model_id: str) -> dict | None:
    r = db.one("SELECT * FROM models WHERE id = ?", (model_id,))
    if r:
        r["input_modalities"] = db.jload(r["input_modalities"], [])
        r["output_modalities"] = db.jload(r["output_modalities"], [])
    return r


def get_alias(name: str) -> dict | None:
    r = db.one("SELECT * FROM aliases WHERE name = ?", (name,))
    if r:
        r["targets"] = db.jload(r["targets"], [])
    return r


def get_preset(name: str) -> dict | None:
    r = db.one("SELECT * FROM presets WHERE name = ?", (name,))
    if r:
        r["params"] = db.jload(r["params"], {})
    return r


def _claude_lookup(name: str) -> str | None:
    """Map Anthropic API model names (claude-sonnet-5-5, claude-haiku-4-5-20251001) to a catalog id."""
    n = re.sub(r"\[.*\]$", "", name.strip())  # e.g. "claude-opus-5-5[1m]"
    n = re.sub(r"-latest$", "", n)
    want = "anthropic." + n
    rows = db.query("SELECT id, base_model_id, route, enabled FROM models WHERE base_model_id LIKE 'anthropic.%'")

    def stem(base: str) -> str:  # anthropic.claude-haiku-4-5-20251001-v1:0 -> anthropic.claude-haiku-4-5-20251001
        return re.sub(r"-v\d+(:\d+)?$", "", base)

    cands = [r for r in rows if stem(r["base_model_id"]) == want]
    if not cands:
        cands = [r for r in rows if re.sub(r"-\d{8}$", "", stem(r["base_model_id"])) == want]
    if not cands:
        # dated name but catalog has undated (or vice versa)
        undated = "anthropic." + re.sub(r"-\d{8}$", "", n)
        cands = [r for r in rows if re.sub(r"-\d{8}$", "", stem(r["base_model_id"])) == undated]
    if not cands:
        return None
    enabled = [r for r in cands if r["enabled"]]
    if not enabled:
        raise GatewayError(403, f"`{name}` maps to {cands[0]['id']}, which is disabled. Enable it on the Models page.",
                           type="permission_error", code="model_disabled", param="model")
    rank = {"profile_global": 0, "on_demand": 1, "profile_geo": 2}
    enabled.sort(key=lambda r: rank.get(r["route"], 9))
    return enabled[0]["id"]


def resolve(name: str, key: dict | None = None, kind: str | None = None) -> Resolved:
    if not name:
        raise GatewayError(400, "`model` is required.", param="model")
    requested = name
    preset = None
    alias_name = None

    pname = name[len("preset/"):] if name.startswith("preset/") else name
    p = get_preset(pname)
    if p is not None:
        preset = p
        name = p["model"]

    targets: list[str]
    a = get_alias(name)
    if a is not None:
        alias_name = name
        targets = list(a["targets"])
    else:
        m = get_model(name)
        if m is not None:
            if not m["enabled"]:
                raise GatewayError(403, f"Model `{name}` is disabled. Enable it on the Models page.",
                                   type="permission_error", code="model_disabled", param="model")
            targets = [name]
        elif name.startswith("claude-") and (cid := _claude_lookup(name)):
            targets = [cid]
        elif "." in name or name.startswith("arn:"):
            targets = [name]  # raw Bedrock id not in the catalog: let Bedrock validate it
        else:
            raise model_not_found(requested)

    if not targets:
        raise model_not_found(requested)

    # Key allow-list: the requested name, the alias, or any target may be listed.
    if key and key.get("allowed_models"):
        allowed = set(key["allowed_models"])
        names = {requested, name, *(targets)}
        if alias_name:
            names.add(alias_name)
        if not names & allowed:
            raise GatewayError(403, f"This API key is not allowed to use `{requested}`.",
                               type="permission_error", code="model_not_allowed", param="model")

    info = {t: (get_model(t) or {}) for t in targets}
    if kind:
        for t, i in info.items():
            if i and i.get("kind") not in (kind, None) and not (kind == "transcription" and i.get("kind") == "chat"):
                raise GatewayError(400, f"`{t}` is a {i.get('kind')} model, not a {kind} model.",
                                   code="wrong_model_kind", param="model")
    return Resolved(requested=requested, targets=targets, preset=preset, alias=alias_name, info=info)


def list_for_key(key: dict | None) -> list[dict]:
    """Models + aliases + presets visible to an API key (for /v1/models)."""
    models = db.query("SELECT id, provider, kind, updated_at FROM models WHERE enabled = 1 ORDER BY provider, id")
    aliases = db.query("SELECT name, targets, created_at FROM aliases ORDER BY name")
    presets = db.query("SELECT name, model, created_at FROM presets ORDER BY name")
    allowed = set(key["allowed_models"]) if key and key.get("allowed_models") else None
    out: list[dict] = []
    for a in aliases:
        targets = db.jload(a["targets"], [])
        if allowed is None or a["name"] in allowed or set(targets) & allowed:
            out.append({"id": a["name"], "object": "model", "created": int(a["created_at"]), "owned_by": "alias",
                        "targets": targets})
    for p in presets:
        if allowed is None or p["name"] in allowed or f"preset/{p['name']}" in allowed or p["model"] in allowed:
            out.append({"id": f"preset/{p['name']}", "object": "model", "created": int(p["created_at"]),
                        "owned_by": "preset", "targets": [p["model"]]})
    for m in models:
        if allowed is None or m["id"] in allowed:
            out.append({"id": m["id"], "object": "model", "created": int(m["updated_at"]),
                        "owned_by": m["provider"].lower(), "kind": m["kind"]})
    return out
