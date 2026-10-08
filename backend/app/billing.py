"""Actual AWS spend (Cost Explorer) and credits (Billing GetCredits), cached.

Cost Explorer charges $0.01 per API call and lags ~24h, so results are cached for
`billing_cache_hours` and only refreshed on demand.
"""
from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from . import aws, db, settings


def _cached(key: str) -> dict | None:
    r = db.one("SELECT value, fetched_at FROM billing_cache WHERE key = ?", (key,))
    if not r:
        return None
    ttl = float(settings.get("billing_cache_hours") or 6) * 3600
    if time.time() - r["fetched_at"] > ttl:
        return None
    v = db.jload(r["value"], {})
    v["fetched_at"] = r["fetched_at"]
    return v


def _store(key: str, value: dict) -> dict:
    now = time.time()
    db.execute("INSERT OR REPLACE INTO billing_cache(key, value, fetched_at) VALUES(?,?,?)",
               (key, db.jdump(value), now))
    value["fetched_at"] = now
    return value


def _bedrock_services(ce) -> list[str]:
    start = (date.today() - timedelta(days=90)).isoformat()
    end = (date.today() + timedelta(days=1)).isoformat()
    vals = ce.get_dimension_values(TimePeriod={"Start": start, "End": end}, Dimension="SERVICE",
                                   SearchString="Bedrock").get("DimensionValues", [])
    return sorted({v["Value"] for v in vals})


def fetch(force: bool = False) -> dict[str, Any]:
    if not settings.get("billing_enabled"):
        return {"enabled": False}
    if not force:
        c = _cached("summary")
        if c:
            return c

    result: dict[str, Any] = {"enabled": True, "errors": []}
    ce = aws.client("ce", region="us-east-1")
    today = date.today()
    month_start = today.replace(day=1)
    start = (month_start - timedelta(days=62)).replace(day=1)
    end = today + timedelta(days=1)

    try:
        services = _bedrock_services(ce)
        result["services"] = services
        if services:
            flt = {"And": [
                {"Dimensions": {"Key": "SERVICE", "Values": services}},
                {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
            ]}
            daily = ce.get_cost_and_usage(
                TimePeriod={"Start": start.isoformat(), "End": end.isoformat()}, Granularity="DAILY",
                Metrics=["UnblendedCost"], Filter=flt, GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}])
            days = []
            for rb in daily.get("ResultsByTime", []):
                total = 0.0
                by_service = {}
                for g in rb.get("Groups", []):
                    amt = float(g["Metrics"]["UnblendedCost"]["Amount"])
                    by_service[g["Keys"][0]] = round(amt, 6)
                    total += amt
                days.append({"date": rb["TimePeriod"]["Start"], "total": round(total, 6), "by_service": by_service})
            result["daily"] = days
            result["month_to_date"] = round(sum(d["total"] for d in days if d["date"] >= month_start.isoformat()), 6)
            prev_start = (month_start - timedelta(days=1)).replace(day=1).isoformat()
            result["last_month"] = round(sum(d["total"] for d in days
                                             if prev_start <= d["date"] < month_start.isoformat()), 6)
        else:
            result["daily"], result["month_to_date"], result["last_month"] = [], 0.0, 0.0

        # Usage-type breakdown this month (input vs output tokens per model)
        if services:
            ut = ce.get_cost_and_usage(
                TimePeriod={"Start": month_start.isoformat(), "End": end.isoformat()}, Granularity="MONTHLY",
                Metrics=["UnblendedCost", "UsageQuantity"],
                Filter={"And": [{"Dimensions": {"Key": "SERVICE", "Values": services}},
                                {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}]},
                GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}])
            rows = []
            for rb in ut.get("ResultsByTime", []):
                for g in rb.get("Groups", []):
                    rows.append({"usage_type": g["Keys"][0],
                                 "cost": round(float(g["Metrics"]["UnblendedCost"]["Amount"]), 6),
                                 "quantity": round(float(g["Metrics"]["UsageQuantity"]["Amount"]), 3)})
            rows.sort(key=lambda r: -r["cost"])
            result["usage_types"] = rows[:50]

        # Credits applied this month (all services: credits are usually account-wide)
        cr = ce.get_cost_and_usage(
            TimePeriod={"Start": month_start.isoformat(), "End": end.isoformat()}, Granularity="MONTHLY",
            Metrics=["UnblendedCost"], Filter={"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit"]}})
        applied = sum(float(rb["Total"]["UnblendedCost"]["Amount"]) for rb in cr.get("ResultsByTime", []))
        result["credits_applied_this_month"] = round(-applied, 6)
    except Exception as e:  # noqa: BLE001
        result["errors"].append(f"Cost Explorer: {aws.error_code(e)}: {aws.error_message(e)}")

    try:
        billing = aws.client("billing", region="us-east-1")
        account_id = aws.client("sts").get_caller_identity()["Account"]
        resp = billing.get_credits(accountId=account_id, startDate=today.replace(day=1).isoformat())
        credits = []
        for c in resp.get("credits", []):
            def amt(x):
                return float((c.get(x) or {}).get("currencyAmount") or 0)
            credits.append({
                "type": c.get("creditType"), "status": c.get("creditStatus"),
                "initial": amt("initialAmount"), "remaining": amt("remainingAmount"),
                "currency": (c.get("remainingAmount") or {}).get("currencyCode", "USD"),
                "products": c.get("applicableProductNames") or [], "end_date": str(c.get("endDate") or ""),
                "exhaust_date": str(c.get("exhaustDate") or ""),
            })
        result["credits"] = credits
        result["credits_remaining"] = round(sum(c["remaining"] for c in credits), 2)
    except Exception as e:  # noqa: BLE001
        result["errors"].append(f"Credits: {aws.error_code(e)}: {aws.error_message(e)}")

    return _store("summary", result)
