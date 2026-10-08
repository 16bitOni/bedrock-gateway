import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CreditCard, Gift, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../api";
import type { BillingResponse } from "../types";
import { useAsync, useDocumentTitle, useNow } from "../hooks";
import { compact, dateTime, money, relTime } from "../format";
import { Banner, Empty, ErrorBanner, PageHeader, Skeleton, SkeletonRows, Spinner, Stat } from "../components/ui";
import { ChartLegend, StackedCostChart, UsageChart } from "../components/charts";
import { useConfirm, useToast } from "../components/feedback";
import { useChartColors } from "../theme";

function shortService(s: string): string {
  return s.replace(/^Amazon /, "").replace(/^AWS /, "").replace(/ \(.*\)$/, "");
}

export function Billing() {
  useDocumentTitle("Billing");
  const { data, error, loading, reload, setData } = useAsync((signal) => api.get<BillingResponse>("/api/billing", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow();
  const colors = useChartColors();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const refresh = async () => {
    const ok = await confirm({
      title: "Refresh from AWS?",
      body: (
        <>
          This calls Cost Explorer and Billing (about <b>$0.03</b> in Cost Explorer API charges — $0.01 per call). AWS cost data lags by roughly <b>24 hours</b>, so today's spend won't
          appear yet. Results are cached.
        </>
      ),
      confirmLabel: "Refresh",
    });
    if (!ok) return;
    setRefreshing(true);
    setRefreshErr(null);
    try {
      const r = await api.post<BillingResponse>("/api/billing/refresh");
      setData(r);
      if (r.aws?.errors?.length) toast.err("Refreshed with errors — see the warning");
      else toast.ok("AWS billing data refreshed");
    } catch (e) {
      setRefreshErr(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const aws = data?.aws && data.aws.enabled !== false ? data.aws : null;
  const services = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of aws?.daily || []) for (const [k, v] of Object.entries(d.by_service)) totals.set(k, (totals.get(k) || 0) + v);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [aws]);
  const stacked = useMemo(
    () =>
      (aws?.daily || []).map((d) => {
        const row: Record<string, number | string> = { date: d.date };
        for (const s of services) row[shortService(s)] = d.by_service[s] || 0;
        return row;
      }),
    [aws, services],
  );
  const estDaily = useMemo(() => (data?.estimated.daily || []).map((d) => ({ date: d.date, cost: d.cost, requests: d.requests })), [data]);
  const maxUsage = Math.max(...(aws?.usage_types || []).map((u) => u.cost), 0.000001);
  const diff = aws?.month_to_date !== undefined && data ? aws.month_to_date - data.estimated.month_to_date : null;
  const showSkeleton = loading && !data;

  return (
    <div className="page">
      <PageHeader
        title="Billing"
        sub={
          aws?.fetched_at ? (
            <span title={dateTime(aws.fetched_at)}>AWS data fetched {relTime(aws.fetched_at, now)} · Cost Explorer lags ~24h</span>
          ) : (
            "Gateway-estimated spend vs. what AWS actually billed, plus credits."
          )
        }
      >
        <button className="btn primary" onClick={refresh} disabled={refreshing || data?.billing_enabled === false}>
          {refreshing ? <Spinner /> : <RefreshCw />} Refresh from AWS
        </button>
      </PageHeader>

      <div className="col gap-12">
        <ErrorBanner error={error} onRetry={reload} />
        {refreshErr && <ErrorBanner title="Refresh failed" error={refreshErr} />}
        {data && data.billing_enabled === false && (
          <Banner kind="info" title="AWS billing lookups are off">
            Only gateway estimates are shown. Turn on “AWS billing” in <Link className="link" to="/settings#billing">Settings → Billing</Link> to compare with Cost Explorer and see credits.
          </Banner>
        )}
        {data && data.billing_enabled !== false && !aws && (
          <Banner kind="accent" title="No AWS billing data yet" action={<button className="btn sm" onClick={refresh} disabled={refreshing}>Fetch now</button>}>
            Press “Refresh from AWS” to pull actual Bedrock spend, usage types and credits from Cost Explorer.
          </Banner>
        )}
        {aws?.errors && aws.errors.length > 0 && (
          <Banner kind="warn" title="Some AWS billing data couldn't be fetched">
            <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
              {aws.errors.map((e) => (
                <li key={e} className="break">
                  {e}
                </li>
              ))}
            </ul>
            <span className="xs">
              The role needs <code className="mono">ce:GetCostAndUsage</code>, <code className="mono">ce:GetDimensionValues</code> and <code className="mono">billing:GetCredits</code> (included in
              the permissions policy in <Link className="link" to="/settings#aws">Settings → AWS</Link>). Cost Explorer must also be enabled once in the Billing console; new accounts take up to 24h.
            </span>
          </Banner>
        )}

        <div className="stats" style={{ "--cols": 4 } as React.CSSProperties}>
          <Stat loading={showSkeleton} label="Gateway estimate · MTD" value={money(data?.estimated.month_to_date)} sub={`last month ${money(data?.estimated.last_month)}`} />
          <Stat
            loading={showSkeleton}
            label="AWS actual · MTD"
            value={aws?.month_to_date !== undefined ? money(aws.month_to_date) : "—"}
            sub={
              diff !== null ? (
                <>
                  {diff >= 0 ? "+" : ""}
                  {money(diff)} vs estimate · last month {money(aws?.last_month)}
                </>
              ) : (
                "not fetched"
              )
            }
          />
          <Stat
            loading={showSkeleton}
            label="Credits remaining"
            value={<span className={aws?.credits_remaining ? "ok-text" : undefined}>{aws?.credits_remaining !== undefined ? money(aws.credits_remaining) : "—"}</span>}
            sub={aws?.credits ? `${aws.credits.length} credit${aws.credits.length === 1 ? "" : "s"}` : "not fetched"}
          />
          <Stat
            loading={showSkeleton}
            label="Credits applied · this month"
            value={aws?.credits_applied_this_month !== undefined ? money(aws.credits_applied_this_month) : "—"}
            sub="all services, from Cost Explorer"
          />
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">AWS daily cost by service</div>
              <span className="card-sub">Bedrock-related services, usage only</span>
            </div>
            <div className="card-body" style={{ paddingLeft: 6 }}>
              {showSkeleton ? (
                <Skeleton h={220} />
              ) : stacked.length ? (
                <div className="col gap-8">
                  <StackedCostChart data={stacked} keys={services.map(shortService)} />
                  <div style={{ paddingLeft: 8 }}>
                    <ChartLegend items={services.map((s, i) => ({ label: shortService(s), color: colors.palette[i % colors.palette.length] }))} />
                  </div>
                </div>
              ) : (
                <Empty small icon={<CreditCard />} title="No AWS cost data" text={aws ? "Cost Explorer returned no Bedrock spend for the last ~3 months." : "Refresh from AWS to load daily costs."} />
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">Gateway-estimated daily cost</div>
              <span className="card-sub">from request logs · this and last month</span>
            </div>
            <div className="card-body" style={{ paddingLeft: 6 }}>
              {showSkeleton ? (
                <Skeleton h={220} />
              ) : estDaily.length ? (
                <UsageChart data={estDaily} metric="cost" />
              ) : (
                <Empty small title="No logged spend" text="Estimates are computed from token counts × the price table in Settings." />
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <Gift size={14} className="muted" />
            <div className="card-title grow">AWS credits</div>
            {aws?.credits_remaining !== undefined && (
              <span className="mono small ok-text" style={{ fontSize: 15 }}>
                {money(aws.credits_remaining)} left
              </span>
            )}
          </div>
          {showSkeleton ? (
            <SkeletonRows rows={3} cols={5} />
          ) : aws?.credits && aws.credits.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Credit</th>
                    <th>Status</th>
                    <th>Applies to</th>
                    <th style={{ minWidth: 200 }}>Remaining</th>
                    <th>Expires</th>
                    <th>Projected exhaustion</th>
                  </tr>
                </thead>
                <tbody>
                  {aws.credits.map((c, i) => (
                    <tr key={i}>
                      <td>{c.type || "Credit"}</td>
                      <td>
                        <span className={`badge ${String(c.status).toUpperCase() === "ACTIVE" ? "ok" : ""}`}>{(c.status || "—").toLowerCase()}</span>
                      </td>
                      <td className="wrap muted xs" style={{ maxWidth: 260 }}>
                        {c.products.length ? c.products.slice(0, 4).join(", ") + (c.products.length > 4 ? ` +${c.products.length - 4}` : "") : "all eligible services"}
                      </td>
                      <td>
                        <div className="col gap-4">
                          <span className="mono xs">
                            {money(c.remaining)} <span className="muted">/ {money(c.initial)} {c.currency !== "USD" ? c.currency : ""}</span>
                          </span>
                          <div className="progress thin ok">
                            <div className="fill" style={{ width: `${c.initial ? Math.min(100, (c.remaining / c.initial) * 100) : 0}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="mono xs">{c.end_date ? c.end_date.slice(0, 10) : "—"}</td>
                      <td className="mono xs">{c.exhaust_date ? c.exhaust_date.slice(0, 10) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty small icon={<Gift />} title={aws ? "No credits on this account" : "Credits not fetched"} text={aws ? "Promotional credits (Activate, startup programs, …) show up here with what's left." : "Refresh from AWS to load credits via billing:GetCredits."} />
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title grow">Usage types · this month</div>
            <span className="card-sub">top 50 by cost</span>
          </div>
          {showSkeleton ? (
            <SkeletonRows rows={5} cols={3} />
          ) : aws?.usage_types && aws.usage_types.length ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Usage type</th>
                    <th className="num">Quantity</th>
                    <th className="num" style={{ minWidth: 180 }}>
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aws.usage_types.map((u) => (
                    <tr key={u.usage_type}>
                      <td className="mono xs truncate" style={{ maxWidth: 520 }} title={u.usage_type}>
                        {u.usage_type}
                      </td>
                      <td className="num">{compact(u.quantity)}</td>
                      <td className="num">
                        <div className="bar-cell">
                          <span className="minibar">
                            <span style={{ width: `${(u.cost / maxUsage) * 100}%` }} />
                          </span>
                          {money(u.cost)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty small title="No usage types" text={aws ? "No Bedrock usage billed this month yet (or Cost Explorer hasn't caught up)." : "Refresh from AWS to see input/output token line items per model."} />
          )}
        </div>
        {data && data.estimated.month_to_date > 0 && (
          <div className="xs muted">
            Estimates use the price table in <Link className="link" to="/settings#pricing">Settings → Pricing</Link>. If they drift from AWS, correct a price and use “Recalculate past costs”.
          </div>
        )}
      </div>
    </div>
  );
}
