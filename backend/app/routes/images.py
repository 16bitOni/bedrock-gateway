"""POST /v1/images/generations (Nova Canvas, Titan Image, Stability)."""
from __future__ import annotations

import base64
import json
import time
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import aws, catalog, config, settings, translate, usage
from ..auth import authenticate
from ..errors import GatewayError, bad_request
from .common import gateway_headers, read_json, run_with_fallback, session_id

router = APIRouter()

STABILITY_RATIOS = {"16:9": 16 / 9, "1:1": 1.0, "21:9": 21 / 9, "2:3": 2 / 3, "3:2": 3 / 2, "4:5": 4 / 5,
                    "5:4": 5 / 4, "9:16": 9 / 16, "9:21": 9 / 21}


def _size(body: dict) -> tuple[int, int]:
    size = body.get("size") or "1024x1024"
    if size == "auto":
        size = "1024x1024"
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except ValueError as e:
        raise bad_request("size must look like 1024x1024.", param="size") from e
    return w, h


def _snap16(v: int) -> int:
    return max(320, min(4096, int(round(v / 16)) * 16))


def _generate(model_id: str, body: dict) -> tuple[list[str], float]:
    base = translate.base_id(model_id)
    prompt = body.get("prompt") or ""
    n = int(body.get("n") or 1)
    client = aws.client("bedrock-runtime")

    if base.startswith("amazon.nova-canvas") or base.startswith("amazon.titan-image"):
        w, h = _size(body)
        w, h = _snap16(w), _snap16(h)
        while w * h > 4_194_304:
            w, h = _snap16(int(w * 0.9)), _snap16(int(h * 0.9))
        quality = body.get("quality") or "standard"
        premium = quality in ("hd", "high", "premium")
        params = {"text": prompt[:1024]}
        if body.get("negative_prompt"):
            params["negativeText"] = body["negative_prompt"][:1024]
        if body.get("style_preset") and base.startswith("amazon.nova-canvas"):
            params["style"] = body["style_preset"]
        cfg = {"width": w, "height": h, "numberOfImages": max(1, min(5, n)),
               "quality": "premium" if premium else "standard", "cfgScale": float(body.get("cfg_scale") or 6.5)}
        if body.get("seed") is not None:
            cfg["seed"] = int(body["seed"])
        payload = {"taskType": "TEXT_IMAGE", "textToImageParams": params, "imageGenerationConfig": cfg}
        out = json.loads(client.invoke_model(modelId=model_id, body=json.dumps(payload),
                                             contentType="application/json", accept="application/json")["body"].read())
        if out.get("error"):
            raise GatewayError(400, f"Image generation failed: {out['error']}", code="image_generation_failed")
        large = w * h > 1024 * 1024
        mult = 1.0 + (0.5 if premium else 0) + (0.5 if large else 0)
        return out.get("images") or [], mult

    if base.startswith("stability."):
        w, h = _size(body)
        ratio = body.get("aspect_ratio") or min(STABILITY_RATIOS, key=lambda r: abs(STABILITY_RATIOS[r] - w / h))
        images: list[str] = []
        for _ in range(max(1, min(4, n))):
            payload = {"prompt": prompt, "aspect_ratio": ratio, "output_format": "png"}
            if body.get("negative_prompt"):
                payload["negative_prompt"] = body["negative_prompt"]
            if body.get("seed") is not None:
                payload["seed"] = int(body["seed"])
            if base.startswith("stability.sd3"):
                payload["mode"] = "text-to-image"
            out = json.loads(client.invoke_model(modelId=model_id, body=json.dumps(payload),
                                                 contentType="application/json",
                                                 accept="application/json")["body"].read())
            reasons = out.get("finish_reasons") or [None]
            if reasons[0]:
                raise GatewayError(400, f"Image was filtered by the model: {reasons[0]}", code="content_filter")
            images.extend(out.get("images") or [])
        return images, 1.0

    raise bad_request(f"`{model_id}` is not a supported image model (Nova Canvas, Titan Image, Stability).",
                      param="model")


@router.post("/v1/images/generations")
@router.post("/images/generations", include_in_schema=False)
async def generate(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    log = usage.RequestLog(endpoint="images.generations", key=key, requested_model=body.get("model") or "image",
                           session_id=session_id(request))
    log.request_body = body
    try:
        if not body.get("prompt"):
            raise bad_request("`prompt` is required.", param="prompt")
        resolved = catalog.resolve(body.get("model") or "image", key, kind="image")
        base_url = (settings.get("public_base_url") or str(request.base_url)).rstrip("/")
        return await run_in_threadpool(_run, body, resolved, log, base_url)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise


def _run(body, resolved, log, base_url):
    _, (images, mult) = run_with_fallback(resolved, log, lambda m: _generate(m, body))
    log.usage.images = len(images)
    log.usage.image_multiplier = mult
    cost = log.compute_cost()
    fmt = body.get("response_format") or "url"
    data = []
    for b64 in images:
        if fmt == "b64_json":
            data.append({"b64_json": b64, "revised_prompt": body.get("prompt")})
        else:
            name = f"{uuid.uuid4().hex}.png"
            (config.IMAGES_DIR / name).write_bytes(base64.b64decode(b64))
            data.append({"url": f"{base_url}/files/images/{name}", "revised_prompt": body.get("prompt")})
    log.response_body = {"images": len(images), "urls": [d.get("url") for d in data if d.get("url")]}
    log.finish(200)
    return JSONResponse({"created": int(time.time()), "data": data, "usage": {"images": len(images),
                                                                             "cost": round(cost, 6)}},
                        headers=gateway_headers(log, {"x-portal-cost-usd": f"{cost:.6f}"}))
