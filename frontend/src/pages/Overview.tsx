import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Cloud, Coins, KeyRound, RefreshCw, Zap } from "lucide-react";
import { api, errorMessage, qs } from "../api";
import type { Overview as OverviewData, SyncResult } from "../types";
import { useAsync, useDocumentTitle, useNow } from "../hooks";
import { compact, duration, int, money, pct, relTime, shortModel } from "../format";
import { Banner, Empty, ErrorBanner, PageHeader, Progress, Seg, Skeleton, SkeletonRows, Spinner, Stat, StatusBadge } from "../components/ui";
import { UsageChart } from "../components/charts";
import { useToast } from "../components/feedback";
import { invalidateV1Models } from "../components/ModelPicker";
import { storage } from "../storage";

type Days = 7 | 30 | 90;

export function Overview() {
  useDocumentTitle("Overview");
  const [days, setDays] = useState<Days>(() => {
    const v = Number(storage.get("portal.overview.days"));
    return v === 7 || v === 90 ? v : 30;
  });
  const [metric, setMetric] = useState<"cost" | "requests" | "tokens">("cost");
  const { data, error, loading, reload } = useAsync((signal) => api.get<OverviewData>(`/api/overview${qs({ days })}`, { signal }), [days]);
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const now = useNow();

  const period = useMemo(() => {
    if (!data) return null;
    const s = data.series.reduce(
      (a, p) => ({
        requests: a.requests + p.requests,
        cost: a.cost + p.cost,
        input: a.input + p.input_tokens,
        output: a.output + p.output_tokens,
        errors: a.errors + p.errors,
      }),
      { requests: 0, cost: 0, input: 0, output: 0, errors: 0 },
    );
    return s;
  }, [data]);

  const sync = async () => {
    setSyncing(true);
    setSyncErr(null);
    try {
      const r = await api.post<SyncResult>("/api/models/sync");
      toast.ok(`Synced ${r.models} models · ${r.enabled} enabled · ${r.aliases_created} aliases created`);
      invalidateV1Models();
      await reload();
    } catch (e) {
      setSyncErr(errorMessage(e));
      toast.err("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const needsOnboarding = data && (!data.catalog.synced_at || data.catalog.total_models === 0);
  const showSkeleton = loading && !data;
  const maxModelCost = Math.max(...(data?.by_model.map((m) => m.cost || 0) || [0]), 0.000001);
  const maxKeyCost = Math.max(...(data?.by_key.map((m) => m.cost || 0) || [0]), 0.000001);
  const maxEndpointReq = Math.max(...(data?.by_endpoint.map((m) => m.requests) || [0]), 1);
  const errorRate = period && period.requests ? period.errors / period.requests : null;
  const cap = data?.budget.monthly_cap ?? null;
  const alertPct = data?.budget.alert_pct ?? 80;

  return (
    <div className="page">
      <PageHeader title="Overview" sub={data ? `${int(data.catalog.enabled_models)} models enabled · ${int(data.keys_count)} active keys` : "Usage, spend and health of your gateway"}>
        <Seg<Days>
          label="Period"
          value={days}
          onChange={(d) => {
            setDays(d);
            storage.set("portal.overview.days", String(d));
          }}
          options={[
            { value: 7, label: "7d" },
            { value: 30, label: "30d" },
            { value: 90, label: "90d" },
          ]}
        />
        <button className="btn icon sm" onClick={() => reload()} aria-label="Refresh" title="Refresh">
          {loading ? <Spinner /> : <RefreshCw />}
        </button>
      </PageHeader>

      <div className="col gap-12">
        <ErrorBanner error={error} onRetry={reload} />

        {needsOnboarding && (
          <div className="onboard">
            <div style={{ minWidth: 0 }}>
              <div className="onboard-title row">
                <Cloud size={16} className="accent-text" /> Connect AWS & sync models
              </div>
              <ol>
                <li>
                  Open <Link className="link" to="/settings#aws">Settings → AWS connection</Link> and deploy the IAM role (or use your default credentials).
                </li>
                <li>Press “Test connection”, then sync the Bedrock model catalog.</li>
                <li>
                  Create an <Link className="link" to="/keys">API key</Link> and point any OpenAI or Anthropic SDK at this gateway.
                </li>
              </ol>
              {syncErr && (
                <div className="mt-8">
                  <ErrorBanner error={syncErr} />
                </div>
              )}
            </div>
            <div className="row wrap">
              <Link className="btn" to="/settings#aws">
                Settings <ArrowRight />
              </Link>
              <button className="btn primary" onClick={sync} disabled={syncing}>
                {syncing ? <Spinner /> : <RefreshCw />}
                Sync models
              </button>
            </div>
          </div>
        )}

        <div className="stats" style={{ "--cols": 4 } as React.CSSProperties}>
          <Stat loading={showSkeleton} label="Spend today" value={money(data?.today.cost)} sub={`${int(data?.today.requests)} requests`} />
          <Stat
            loading={showSkeleton}
            label="This month"
            value={money(data?.month.cost)}
            sub={
              <>
                forecast <span className="mono">{money(data?.forecast_month)}</span>
              </>
            }
          />
          <Stat loading={showSkeleton} label="All time" value={money(data?.all_time.cost)} sub={`${compact(data?.all_time.requests)} requests`} />
          <Stat
            loading={showSkeleton}
            label={`Requests · ${days}d`}
            value={int(period?.requests)}
            sub={
              <>
                <span className="mono">{int(period?.errors)}</span> errors
              </>
            }
          />
          <Stat loading={showSkeleton} label={`Tokens in · ${days}d`} value={compact(period?.input)} sub={`${compact(data?.month.cache_read_tokens)} cache-read this month`} />
          <Stat loading={showSkeleton} label={`Tokens out · ${days}d`} value={compact(period?.output)} sub={`${money(period?.cost)} spent in ${days}d`} />
          <Stat
            loading={showSkeleton}
            label={`Error rate · ${days}d`}
            value={<span className={errorRate && errorRate > 0.05 ? "err-text" : undefined}>{errorRate === null ? "—" : pct(errorRate)}</span>}
            sub={`${int(data?.today.errors)} errors today`}
          />
          <Stat
            loading={showSkeleton}
            label="Latency · 24h"
            value={
              <>
                {duration(data?.latency_24h.p50)}
                <span className="muted" style={{ fontSize: 13 }}>
                  {" "}
                  / {duration(data?.latency_24h.p95)}
                </span>
              </>
            }
            sub={
              <>
                p50 / p95 · TTFT <span className="mono">{duration(data?.latency_24h.ttft_p50)}</span> / <span className="mono">{duration(data?.latency_24h.ttft_p95)}</span>
              </>
            }
          />
        </div>

        <div className="grid grid-main-side">
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">Daily {metric === "cost" ? "cost" : metric === "requests" ? "requests" : "tokens"}</div>
              <Seg
                label="Metric"
                value={metric}
                onChange={setMetric}
                options={[
                  { value: "cost", label: "Cost" },
                  { value: "requests", label: "Requests" },
                  { value: "tokens", label: "Tokens" },
                ]}
              />
            </div>
            <div className="card-body" style={{ paddingLeft: 6 }}>
              {showSkeleton ? <Skeleton h={220} /> : data && <UsageChart data={data.series} metric={metric} />}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <Coins size={14} className="muted" />
              <div className="card-title grow">Budgets · this month</div>
              <Link to="/settings#gateway" className="btn ghost xs">
                Edit
              </Link>
            </div>
            <div className="card-body col gap-16">
              {showSkeleton ? (
                <>
                  <Skeleton h={10} w="50%" />
                  <Skeleton h={6} />
                  <Skeleton h={10} w="40%" />
                  <Skeleton h={6} />
                </>
              ) : data ? (
                <>
                  <div className="col gap-4">
                    <div className="row">
                      <span className="grow small">Global cap</span>
                      <span className="mono small">
                        {money(data.budget.spent)}
                        <span className="muted"> / {cap ? money(cap) : "∞"}</span>
                      </span>
                    </div>
                    {cap ? (
                      <>
                        <Progress value={data.budget.spent} max={cap} alertAt={alertPct} label="Global budget" />
                        <div className="xs muted">
                          {pct(data.budget.spent / cap, 0)} used · alert at {alertPct}% · forecast {money(data.forecast_month)}
                        </div>
                        {data.budget.spent / cap >= alertPct / 100 && (
                          <Banner kind={data.budget.spent >= cap ? "err" : "warn"}>
                            {data.budget.spent >= cap ? "Global budget reached — requests are being rejected with 429." : `Over ${alertPct}% of the monthly budget.`}
                          </Banner>
                        )}
                      </>
                    ) : (
                      <div className="xs muted">
                        No global cap. <Link className="link" to="/settings#gateway">Set a monthly budget</Link> to hard-stop spend.
                      </div>
                    )}
                  </div>
                  {data.budget.keys.length > 0 && <hr className="divider" style={{ margin: 0 }} />}
                  {data.budget.keys.map((k) => (
                    <div key={k.id} className="col gap-4">
                      <div className="row">
                        <KeyRound size={12} className="muted" />
                        <span className="grow small truncate">{k.name}</span>
                        <span className="mono xs">
                          {money(k.spent)}
                          <span className="muted"> / {money(k.budget)}</span>
                        </span>
                      </div>
                      <Progress value={k.spent} max={k.budget} alertAt={alertPct} thin label={`${k.name} budget`} />
                    </div>
                  ))}
                  {data.budget.keys.length === 0 && (
                    <div className="xs muted">
                      No per-key budgets. Add one when <Link className="link" to="/keys">creating or editing a key</Link>.
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-3">
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">Top models</div>
              <span className="card-sub">{days}d by cost</span>
            </div>
            {showSkeleton ? (
              <SkeletonRows rows={5} cols={3} />
            ) : data && data.by_model.length ? (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="num">Req</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.slice(0, 8).map((m) => (
                      <tr key={m.model || "?"}>
                        <td className="mono" style={{ maxWidth: 200 }}>
                          <Link to={`/logs${qs({ model: m.model })}`} className="truncate" style={{ display: "block" }} title={m.model || ""}>
                            {shortModel(m.model)}
                          </Link>
                        </td>
                        <td className="num">{compact(m.requests)}</td>
                        <td className="num">
                          <div className="bar-cell" style={{ minWidth: 110 }}>
                            <span className="minibar">
                              <span style={{ width: `${((m.cost || 0) / maxModelCost) * 100}%` }} />
                            </span>
                            {money(m.cost)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty small title="No traffic yet" text="Send a request from the Playground to see it here." action={<Link className="btn sm" to="/playground">Open Playground</Link>} />
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title grow">By key</div>
              <span className="card-sub">{days}d</span>
            </div>
            {showSkeleton ? (
              <SkeletonRows rows={5} cols={3} />
            ) : data && data.by_key.length ? (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th className="num">Req</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_key.map((k) => (
                      <tr key={String(k.key_id)}>
                        <td style={{ maxWidth: 180 }}>
                          <Link to={`/logs${qs({ key_id: k.key_id ?? "" })}`} className="truncate" style={{ display: "block" }}>
                            {k.key_name || (k.key_id === 0 ? "Playground" : `key #${k.key_id}`)}
                          </Link>
                        </td>
                        <td className="num">{compact(k.requests)}</td>
                        <td className="num">
                          <div className="bar-cell" style={{ minWidth: 110 }}>
                            <span className="minibar">
                              <span style={{ width: `${((k.cost || 0) / maxKeyCost) * 100}%` }} />
                            </span>
                            {money(k.cost)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty small title="No keys used yet" text="Requests are attributed to the API key that made them." action={<Link className="btn sm" to="/keys">Create a key</Link>} />
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title grow">By endpoint</div>
              <span className="card-sub">{days}d</span>
            </div>
            {showSkeleton ? (
              <SkeletonRows rows={5} cols={3} />
            ) : data && data.by_endpoint.length ? (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Endpoint</th>
                      <th className="num">Req</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_endpoint.map((e) => (
                      <tr key={e.endpoint}>
                        <td className="mono">
                          <Link to={`/logs${qs({ endpoint: e.endpoint })}`}>{e.endpoint}</Link>
                        </td>
                        <td className="num">
                          <div className="bar-cell" style={{ minWidth: 90 }}>
                            <span className="minibar">
                              <span style={{ width: `${(e.requests / maxEndpointReq) * 100}%` }} />
                            </span>
                            {compact(e.requests)}
                          </div>
                        </td>
                        <td className="num">{money(e.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty small title="No endpoints hit yet" text="Chat, embeddings, images, speech and rerank all show up here." />
            )}
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-header">
              <Zap size={14} className="muted" />
              <div className="card-title grow">Most expensive requests · this month</div>
            </div>
            {showSkeleton ? (
              <SkeletonRows rows={5} cols={4} />
            ) : data && data.top_requests.length ? (
              <div>
                {data.top_requests.map((r) => (
                  <Link key={r.id} to={`/logs${qs({ id: r.id })}`} className="list-row">
                    <span className="mono small accent-text nowrap" style={{ width: 82 }}>
                      {money(r.cost_usd)}
                    </span>
                    <span className="grow col gap-4" style={{ gap: 0 }}>
                      <span className="mono small truncate" title={r.resolved_model || r.requested_model || ""}>{shortModel(r.resolved_model || r.requested_model)}</span>
                      <span className="xs muted">
                        {r.endpoint} · {compact(r.input_tokens)} in / {compact(r.output_tokens)} out · {relTime(r.ts, now)}
                      </span>
                    </span>
                    <ArrowRight size={13} className="faint" />
                  </Link>
                ))}
              </div>
            ) : (
              <Empty small title="Nothing billed this month" text="The five most expensive requests of the month will be listed here." />
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <AlertTriangle size={14} className="muted" />
              <div className="card-title grow">Recent errors</div>
              <Link className="btn ghost xs" to="/logs?status=error">
                All errors <ArrowRight />
              </Link>
            </div>
            {showSkeleton ? (
              <SkeletonRows rows={5} cols={4} />
            ) : data && data.recent_errors.length ? (
              <div>
                {data.recent_errors.map((r) => (
                  <Link key={r.id} to={`/logs${qs({ id: r.id })}`} className="list-row">
                    <StatusBadge status={r.status} />
                    <span className="grow col" style={{ gap: 0 }}>
                      <span className="small truncate" title={r.error_message || ""}>
                        {r.error_message || r.error_code || "Error"}
                      </span>
                      <span className="xs muted truncate">
                        <span className="mono">{r.requested_model || "—"}</span> · {r.endpoint} · {relTime(r.ts, now)}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty small title="No errors" text="Failed requests (4xx/5xx) show up here with the upstream message." />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
