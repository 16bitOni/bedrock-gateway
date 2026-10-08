"""/v1/models, /v1/rerank and helpers."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import aws, catalog, settings, translate, usage
from ..auth import authenticate
from ..errors import GatewayError, bad_request, model_not_found
from .common import gateway_headers, read_json, run_with_fallback, session_id

router = APIRouter()


@router.get("/v1/models")
async def list_models(key: dict = Depends(authenticate)):
    return {"object": "list", "data": catalog.list_for_key(key)}


@router.get("/v1/models/{model_id:path}")
async def get_model(model_id: str, key: dict = Depends(authenticate)):
    for m in catalog.list_for_key(key):
        if m["id"] == model_id:
            return m
    raise model_not_found(model_id)


def _rerank(model_id: str, query: str, docs: list, top_n: int | None) -> list[dict]:
    region = settings.get("aws_region") or "us-east-1"
    base = translate.base_id(model_id)
    arn = model_id if model_id.startswith("arn:") else f"arn:aws:bedrock:{region}::foundation-model/{base}"
    sources = []
    for d in docs:
        text = d if isinstance(d, str) else (d.get("text") if isinstance(d, dict) else str(d))
        sources.append({"type": "INLINE", "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": text}}})
    resp = aws.client("bedrock-agent-runtime").rerank(
        queries=[{"type": "TEXT", "textQuery": {"text": query}}],
        sources=sources,
        rerankingConfiguration={"type": "BEDROCK_RERANKING_MODEL", "bedrockRerankingConfiguration": {
            "numberOfResults": int(top_n or len(docs)), "modelConfiguration": {"modelArn": arn}}},
    )
    return resp.get("results", [])


@router.post("/v1/rerank")
@router.post("/rerank", include_in_schema=False)
async def rerank(request: Request, key: dict = Depends(authenticate)):
    """Cohere/Jina-style rerank: {model, query, documents, top_n, return_documents}."""
    body = await read_json(request)
    log = usage.RequestLog(endpoint="rerank", key=key, requested_model=body.get("model") or "rerank",
                           session_id=session_id(request))
    log.request_body = body
    try:
        query = body.get("query")
        docs = body.get("documents") or []
        if not query or not docs:
            raise bad_request("`query` and `documents` are required.")
        if len(docs) > 1000:
            raise bad_request("At most 1000 documents per request.", param="documents")
        resolved = catalog.resolve(body.get("model") or "rerank", key, kind="rerank")

        def run():
            _, results = run_with_fallback(resolved, log, lambda m: _rerank(m, query, docs, body.get("top_n")))
            log.usage.queries = max(1, (len(docs) + 99) // 100)  # billed per query of up to 100 docs
            cost = log.compute_cost()
            out = []
            for r in results:
                item = {"index": r["index"], "relevance_score": r["relevanceScore"]}
                if body.get("return_documents", True):
                    d = docs[r["index"]]
                    item["document"] = {"text": d if isinstance(d, str) else d.get("text")}
                out.append(item)
            payload = {"id": log.id, "model": body.get("model") or log.resolved_model, "results": out,
                       "usage": {"queries": log.usage.queries, "cost": round(cost, 6)}}
            log.response_body = {"results": out[:20]}
            log.finish(200)
            return JSONResponse(payload, headers=gateway_headers(log, {"x-portal-cost-usd": f"{cost:.6f}"}))

        return await run_in_threadpool(run)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise
