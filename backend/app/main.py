"""FastAPI application entry point.  Run:  uvicorn app.main:app --port 8787"""
from __future__ import annotations

import re
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, auth, catalog, config, db, pricing, settings, usage
from .errors import GatewayError
from .routes import admin, anthropic, audio, chat, embeddings, images, misc


def _housekeeping_loop() -> None:
    while True:
        time.sleep(3600)
        try:
            usage.purge_old()
        except Exception as e:  # noqa: BLE001
            print(f"[portal] housekeeping failed: {e}")


def startup() -> None:
    config.ensure_dirs()
    db.init()
    settings.bootstrap()
    auth.bootstrap_admin()
    pricing.seed_defaults()
    catalog.ensure_virtual_models()
    usage.start_worker()


@asynccontextmanager
async def lifespan(_: FastAPI):
    startup()
    if not config.TESTING:
        threading.Thread(target=_housekeeping_loop, daemon=True, name="portal-housekeeping").start()
    yield
    usage.flush()


app = FastAPI(title="Bedrock Portal", version=__version__, lifespan=lifespan,
              description="OpenAI- and Anthropic-compatible gateway for Amazon Bedrock.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["x-request-id", "x-portal-cost-usd", "x-portal-model", "x-portal-attempt",
                                   "x-portal-cache"])


def _is_anthropic_path(path: str) -> bool:
    return path.startswith("/v1/messages") or path.startswith("/anthropic/")


@app.exception_handler(GatewayError)
async def gateway_error_handler(request: Request, exc: GatewayError):
    body = exc.anthropic_body() if _is_anthropic_path(request.url.path) else exc.openai_body()
    headers = dict(exc.headers)
    rid = getattr(request.state, "request_id", None)
    if rid:
        headers["x-request-id"] = rid
    return JSONResponse(body, status_code=exc.status, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return await gateway_error_handler(request, GatewayError(400, f"Invalid request: {exc.errors()}"))


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    if request.url.path.startswith(("/v1", "/api", "/anthropic")):
        return await gateway_error_handler(request, GatewayError(exc.status_code, str(exc.detail),
                                                                 code="not_found" if exc.status_code == 404 else None))
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    print(f"[portal] unhandled error on {request.url.path}: {exc!r}")
    return await gateway_error_handler(request, GatewayError(500, f"Internal error: {exc}", type="api_error",
                                                             code="internal_error"))


for r in (chat.router, embeddings.router, images.router, audio.router, misc.router, anthropic.router,
          admin.public, admin.router):
    app.include_router(r)


_IMAGE_NAME = re.compile(r"[0-9a-f]{32}\.png")


@app.get("/health")
async def health():
    return {"ok": True, "version": __version__}


@app.get("/files/images/{name}")
async def image_file(name: str):
    if not _IMAGE_NAME.fullmatch(name):
        return JSONResponse({"detail": "not found"}, status_code=404)
    path = config.IMAGES_DIR / name
    if not path.exists():
        return JSONResponse({"detail": "not found"}, status_code=404)
    return FileResponse(path, media_type="image/png")


# ---- dashboard (built React app) ----
if (config.FRONTEND_DIST / "index.html").exists():
    if (config.FRONTEND_DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith(("v1/", "api/", "anthropic/")):
            return JSONResponse({"error": {"message": "Not found", "type": "invalid_request_error",
                                           "code": "not_found"}}, status_code=404)
        if full_path and "\\" not in full_path and ":" not in full_path and ".." not in full_path:
            candidate = (config.FRONTEND_DIST / full_path).resolve()
            if candidate.is_relative_to(config.FRONTEND_DIST) and candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(config.FRONTEND_DIST / "index.html")
else:
    @app.get("/", include_in_schema=False)
    async def no_ui():
        return JSONResponse({"message": "Bedrock Portal API is running. The dashboard is not built yet: "
                                        "cd frontend && npm install && npm run build", "docs": "/docs"})
