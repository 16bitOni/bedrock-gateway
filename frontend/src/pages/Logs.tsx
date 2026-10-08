import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Eraser, FlaskConical, Pause, Play, RefreshCw, ScrollText, Search, Trash2 } from "lucide-react";
import { api, downloadAuthed, errorMessage, qs } from "../api";
import type { ApiKey, LogDetail, LogRow, LogsResponse } from "../types";
import { useAsync, useDebounced, useDocumentTitle, useInterval } from "../hooks";
import { compact, dateTime, duration, int, money, prettyJson, shortModel, shortTime } from "../format";
import { Banner, CodeBlock, CopyButton, Drawer, Empty, ErrorBanner, Field, Modal, PageHeader, SkeletonRows, Spinner, StatusBadge, Switch, Tabs } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { replayFromBody, responseToMsg, type ChatMsg } from "./playground/chat";
import { AssistantBody, ToolResultCard } from "./playground/parts";

const ENDPOINTS = ["chat.completions", "messages", "embeddings", "images.generations", "audio.speech", "audio.transcriptions", "rerank"];
const LIMIT = 50;
const FILTER_KEYS = ["q", "key_id", "model", "endpoint", "status", "session_id"] as const;

export function Logs() {
  useDocumentTitle("Logs");
  const [search, setSearch] = useSearchParams();
  const toast = useToast();
  const [auto, setAuto] = useState(false);
  const [showPurge, setShowPurge] = useState(false);
  const [exporting, setExporting] = useState(false);
  const keys = useAsync((signal) => api.get<{ data: ApiKey[] }>("/api/keys", { signal }), []);

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = search.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [search]);
  const offset = Math.max(0, Number(search.get("offset") || 0));
  const openId = search.get("id");

  const [qDraft, setQDraft] = useState(filters.q || "");
  const [modelDraft, setModelDraft] = useState(filters.model || "");
  const [sessionDraft, setSessionDraft] = useState(filters.session_id || "");
  const qDeb = useDebounced(qDraft, 350);
  const modelDeb = useDebounced(modelDraft, 450);
  const sessionDeb = useDebounced(sessionDraft, 450);

  const setParam = (patch: Record<string, string | null>, resetOffset = true) => {
    const n = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") n.delete(k);
      else n.set(k, v);
    }
    if (resetOffset) n.delete("offset");
    setSearch(n, { replace: true });
  };

  useEffect(() => {
    if ((filters.q || "") !== qDeb) setParam({ q: qDeb });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeb]);
  useEffect(() => {
    if ((filters.model || "") !== modelDeb) setParam({ model: modelDeb });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelDeb]);
  useEffect(() => {
    if ((filters.session_id || "") !== sessionDeb) setParam({ session_id: sessionDeb });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDeb]);
  // Keep drafts in sync with external navigation (e.g. links from Overview).
  useEffect(() => setModelDraft(filters.model || ""), [filters.model]);
  useEffect(() => setSessionDraft(filters.session_id || ""), [filters.session_id]);

  const filterKey = JSON.stringify(filters) + offset;
  const { data, error, loading, reload } = useAsync((signal) => api.get<LogsResponse>(`/api/logs${qs({ ...filters, limit: LIMIT, offset })}`, { signal }), [filterKey]);
  useInterval(() => void reload(), auto ? 5000 : null);

  const hasFilters = Object.keys(filters).length > 0;
  const rows = data?.data || [];
  const total = data?.total ?? 0;

  const doExport = async () => {
    setExporting(true);
    try {
      await downloadAuthed(`/api/logs/export${qs(filters)}`, "portal-logs.jsonl");
      toast.ok("Export downloaded");
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page wide">
      <PageHeader
        title="Logs"
        sub={
          data ? (
            <>
              <span className="mono">{int(total)}</span> requests · <span className="mono">{money(data.aggregate.cost)}</span> · <span className="mono">{compact(data.aggregate.input_tokens)}</span> in /{" "}
              <span className="mono">{compact(data.aggregate.output_tokens)}</span> out{hasFilters ? " (filtered)" : ""}
            </>
          ) : (
            "Every request through the gateway, with tokens, cost and latency."
          )
        }
      >
        <label className="check small" title="Refresh every 5 seconds">
          <Switch checked={auto} onChange={setAuto} label="Auto-refresh" />
          {auto ? <Play size={12} className="ok-text" /> : <Pause size={12} />} Live
        </label>
        <button className="btn sm icon" aria-label="Refresh" onClick={() => reload()}>
          {loading ? <Spinner /> : <RefreshCw />}
        </button>
        <button className="btn sm" onClick={doExport} disabled={exporting || !total}>
          {exporting ? <Spinner /> : <Download />} Export JSONL
        </button>
        <button className="btn sm danger" onClick={() => setShowPurge(true)}>
          <Trash2 /> Purge
        </button>
      </PageHeader>

      <div className="col gap-12">
        <ErrorBanner error={error} onRetry={reload} />
        <div className="card">
          <div className="toolbar">
            <div className="input-group">
              <Search />
              <input className="input" placeholder="Search id, model, error, body…" aria-label="Search logs" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
            </div>
            <select className="select" aria-label="Key" value={filters.key_id ?? ""} onChange={(e) => setParam({ key_id: e.target.value })}>
              <option value="">All keys</option>
              <option value="0">Playground</option>
              {(keys.data?.data || []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
            <select className="select" aria-label="Endpoint" value={filters.endpoint ?? ""} onChange={(e) => setParam({ endpoint: e.target.value })}>
              <option value="">All endpoints</option>
              {ENDPOINTS.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
            <select className="select" aria-label="Status" value={filters.status ?? ""} onChange={(e) => setParam({ status: e.target.value })}>
              <option value="">Any status</option>
              <option value="ok">Success</option>
              <option value="error">Errors</option>
            </select>
            <input className="input mono" style={{ width: 200, flex: "0 1 200px" }} placeholder="model (exact)" aria-label="Model" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} />
            <input className="input mono" style={{ width: 150, flex: "0 1 150px" }} placeholder="session id" aria-label="Session id" value={sessionDraft} onChange={(e) => setSessionDraft(e.target.value)} />
            {hasFilters && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setQDraft("");
                  setModelDraft("");
                  setSessionDraft("");
                  setSearch(new URLSearchParams(), { replace: true });
                }}
              >
                <Eraser /> Clear
              </button>
            )}
          </div>
          {loading && !data ? (
            <SkeletonRows rows={12} cols={8} />
          ) : rows.length === 0 ? (
            <Empty
              icon={<ScrollText />}
              title={hasFilters ? "No requests match" : "No requests logged yet"}
              text={hasFilters ? "Try widening the filters." : "Make a call from the Playground or any SDK pointed at this gateway."}
              action={
                hasFilters ? undefined : (
                  <Link className="btn sm" to="/playground">
                    Open Playground
                  </Link>
                )
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th className="hide-sm">Key</th>
                    <th className="hide-sm">Endpoint</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th className="num hide-sm">Tokens in / out</th>
                    <th className="num">Cost</th>
                    <th className="num hide-sm">Latency</th>
                    <th className="hide-sm" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <LogTableRow key={r.id} r={r} selected={r.id === openId} onOpen={() => setParam({ id: r.id }, false)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && total > 0 && (
            <div className="pager">
              <span>
                <span className="mono">{int(offset + 1)}</span>–<span className="mono">{int(Math.min(offset + LIMIT, total))}</span> of <span className="mono">{int(total)}</span>
              </span>
              <span className="spacer" />
              <button className="btn sm" disabled={offset === 0} onClick={() => setParam({ offset: String(Math.max(0, offset - LIMIT)) }, false)}>
                <ChevronLeft /> Newer
              </button>
              <button className="btn sm" disabled={offset + LIMIT >= total} onClick={() => setParam({ offset: String(offset + LIMIT) }, false)}>
                Older <ChevronRight />
              </button>
            </div>
          )}
        </div>
      </div>
      {openId && <LogDrawer id={openId} onClose={() => setParam({ id: null }, false)} onFilter={(p) => setParam({ ...p, id: null })} />}
      {showPurge && (
        <PurgeDialog
          onClose={() => setShowPurge(false)}
          onDone={() => {
            setShowPurge(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function LogTableRow({ r, selected, onOpen }: { r: LogRow; selected: boolean; onOpen: () => void }) {
  const resolvedDiffers = r.resolved_model && r.resolved_model !== r.requested_model;
  return (
    <tr className={`clickable ${selected ? "selected" : ""}`} onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <td className="mono muted" title={dateTime(r.ts)}>
        {shortTime(r.ts)}
      </td>
      <td className="truncate hide-sm" style={{ maxWidth: 140 }}>
        {r.key_name || (r.key_id === 0 ? "Playground" : r.key_id ?? "—")}
      </td>
      <td className="mono xs hide-sm">{r.endpoint}</td>
      <td style={{ maxWidth: 280 }}>
        <div className="row gap-4" style={{ minWidth: 0 }}>
          <span className="mono xs truncate" title={`${r.requested_model || ""}${resolvedDiffers ? ` → ${r.resolved_model}` : ""}`}>
            {r.requested_model || "—"}
            {resolvedDiffers && <span className="muted"> → {shortModel(r.resolved_model)}</span>}
          </span>
          {r.attempt > 1 && (
            <span className="badge warn" title="Served by a fallback target">
              fallback #{r.attempt}
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="row gap-4">
          <StatusBadge status={r.status} />
          {r.cached ? <span className="badge ok">cached</span> : null}
          {r.stream ? <span className="badge ghost">stream</span> : null}
          {r.status >= 400 && r.error_code && (
            <span className="xs err-text truncate" style={{ maxWidth: 160 }} title={r.error_message || ""}>
              {r.error_code}
            </span>
          )}
        </div>
      </td>
      <td className="num hide-sm">
        {r.input_tokens || r.output_tokens ? (
          <>
            {compact(r.input_tokens)} / {compact(r.output_tokens)}
            {r.cache_read_tokens ? <span className="ok-text" title="cache read tokens"> +{compact(r.cache_read_tokens)}c</span> : null}
          </>
        ) : r.units ? (
          <span className="muted">{compact(r.units)} units</span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="num">{r.cost_usd ? money(r.cost_usd) : <span className="faint">$0</span>}</td>
      <td className="num hide-sm">
        {duration(r.latency_ms)}
        {r.ttft_ms !== null && r.stream ? <span className="muted"> · {duration(r.ttft_ms)}</span> : null}
      </td>
      <td className="actions hide-sm">
        <ChevronRight size={14} className="faint" />
      </td>
    </tr>
  );
}

function TranscriptView({ endpoint, req, res }: { endpoint: string; req: unknown; res: unknown }) {
  const st = replayFromBody(endpoint, req);
  const answer = responseToMsg(endpoint, res);
  if (!st) return <Empty small title="No transcript" text="The request body wasn't stored for this call." />;
  const msgs: ChatMsg[] = [...st.messages, ...(answer ? [answer] : [])];
  return (
    <div className="col gap-12">
      <div className="row wrap xs muted">
        <span>
          model <code className="mono">{st.model}</code>
        </span>
        {Object.entries(st.params)
          .filter(([k]) => k !== "tools" && k !== "json_schema")
          .map(([k, v]) => (
            <span key={k} className="chip">
              {k}={String(v)}
            </span>
          ))}
      </div>
      {st.system && (
        <div className="msg">
          <div className="msg-head">
            <span className="msg-role">system</span>
          </div>
          <div className="msg-body" style={{ background: "var(--surface-2)", border: "1px dashed var(--border-strong)", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
            {st.system}
          </div>
        </div>
      )}
      {msgs.map((m, i) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <div className="msg-head">
            <span className="msg-role">{m.role}</span>
            {m === answer && <span className="badge accent">response</span>}
            {i < msgs.length && m.content && (
              <span className="msg-actions">
                <CopyButton text={m.content} />
              </span>
            )}
          </div>
          {m.role === "user" && (
            <>
              {m.images?.length ? (
                <div className="msg-images">
                  {m.images.map((src, j) => (
                    <img key={j} src={src} alt="" />
                  ))}
                </div>
              ) : null}
              {m.content && <div className="msg-body">{m.content}</div>}
            </>
          )}
          {m.role === "tool" && <ToolResultCard id={m.toolCallId} content={m.content} />}
          {m.role === "assistant" && (
            <div className="msg-body">
              <AssistantBody content={m.content} reasoning={m.reasoning} toolCalls={m.toolCalls} />
            </div>
          )}
        </div>
      ))}
      {!answer && <div className="xs muted">No response body stored.</div>}
    </div>
  );
}

function mediaSummary(endpoint: string, res: unknown): React.ReactNode {
  const r = (res || {}) as Record<string, unknown>;
  if (endpoint === "images.generations" && Array.isArray(r.urls) && r.urls.length) {
    return (
      <div className="image-grid">
        {(r.urls as string[]).map((u) => (
          <div key={u} className="image-tile">
            <img src={u} alt="generated" loading="lazy" />
          </div>
        ))}
      </div>
    );
  }
  if (typeof r.text === "string") return <div className="md" style={{ whiteSpace: "pre-wrap" }}>{r.text}</div>;
  if (Array.isArray(r.results)) {
    return (
      <div className="col gap-4">
        {(r.results as { index: number; relevance_score: number; document?: { text?: string } }[]).map((x, i) => (
          <div key={i} className="row small">
            <span className="mono muted" style={{ width: 54 }}>
              {x.relevance_score.toFixed(3)}
            </span>
            <span className="truncate">{x.document?.text ?? `doc ${x.index}`}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function LogDrawer({ id, onClose, onFilter }: { id: string; onClose: () => void; onFilter: (p: Record<string, string>) => void }) {
  const navigate = useNavigate();
  const { data, error, loading } = useAsync((signal) => api.get<LogDetail>(`/api/logs/${encodeURIComponent(id)}`, { signal }), [id]);
  const isChat = data && (data.endpoint === "chat.completions" || data.endpoint === "messages");
  const [tab, setTab] = useState<"transcript" | "request" | "response">("transcript");
  useEffect(() => {
    if (data) setTab(isChat && data.request_body ? "transcript" : "request");
  }, [data, isChat]);

  const media = data && !isChat ? mediaSummary(data.endpoint, data.response_body) : null;

  return (
    <Drawer
      onClose={onClose}
      title={
        <div className="col" style={{ gap: 2 }}>
          <div className="row gap-4">
            {data && <StatusBadge status={data.status} />}
            <span className="mono small truncate">{id}</span>
            <CopyButton text={id} />
          </div>
          {data && (
            <span className="xs muted">
              {dateTime(data.ts)} · {data.endpoint}
            </span>
          )}
        </div>
      }
      actions={
        isChat && data && data.request_body ? (
          <button className="btn sm" onClick={() => navigate(`/playground?replay=${encodeURIComponent(id)}`)}>
            <FlaskConical /> Replay in playground
          </button>
        ) : null
      }
    >
      {loading && !data && (
        <div className="col gap-12">
          <SkeletonRows rows={8} cols={2} />
        </div>
      )}
      <ErrorBanner error={error} />
      {data && (
        <div className="col gap-16">
          {data.status >= 400 && (
            <Banner kind="err" title={`${data.status} ${data.error_code || "error"}`}>
              <span className="break">{data.error_message || "No error message recorded."}</span>
            </Banner>
          )}
          <dl className="kv">
            <dt>Key</dt>
            <dd>
              <button className="link" style={{ background: "none", border: 0, padding: 0, font: "inherit" }} onClick={() => onFilter({ key_id: String(data.key_id ?? "") })}>
                {data.key_name || (data.key_id === 0 ? "Playground" : `#${data.key_id}`)}
              </button>
            </dd>
            <dt>Requested model</dt>
            <dd className="mono small">{data.requested_model || "—"}</dd>
            <dt>Resolved model</dt>
            <dd className="mono small">
              {data.resolved_model || "—"}
              {data.attempt > 1 && <span className="badge warn" style={{ marginLeft: 6 }}>fallback attempt #{data.attempt}</span>}
            </dd>
            <dt>Tokens</dt>
            <dd className="mono small">
              {int(data.input_tokens)} in · {int(data.output_tokens)} out
              {data.cache_read_tokens ? ` · ${int(data.cache_read_tokens)} cache read` : ""}
              {data.cache_write_tokens ? ` · ${int(data.cache_write_tokens)} cache write` : ""}
              {data.units ? ` · ${compact(data.units)} units` : ""}
            </dd>
            <dt>Cost</dt>
            <dd className="mono small">
              {money(data.cost_usd, { zero: "$0" })}
              {data.cached ? <span className="badge ok" style={{ marginLeft: 6 }}>cache hit</span> : null}
            </dd>
            <dt>Latency</dt>
            <dd className="mono small">
              {duration(data.latency_ms)}
              {data.ttft_ms !== null ? ` · TTFT ${duration(data.ttft_ms)}` : ""}
              {data.stream ? " · streamed" : ""}
            </dd>
            <dt>Finish reason</dt>
            <dd className="mono small">{data.finish_reason || "—"}</dd>
            {data.session_id && (
              <>
                <dt>Session</dt>
                <dd>
                  <button className="link mono small" style={{ background: "none", border: 0, padding: 0 }} onClick={() => onFilter({ session_id: data.session_id || "" })}>
                    {data.session_id}
                  </button>
                </dd>
              </>
            )}
          </dl>
          {media && (
            <div className="card card-pad">
              <div className="label mb-8">Output</div>
              {media}
            </div>
          )}
          {data.request_body === null && data.response_body === null ? (
            <Banner kind="info">Bodies weren't stored for this request (body logging is off for this key or in Settings → Gateway).</Banner>
          ) : (
            <div className="col gap-12">
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  ...(isChat ? [{ value: "transcript" as const, label: "Transcript" }] : []),
                  { value: "request" as const, label: "Request JSON" },
                  { value: "response" as const, label: "Response JSON" },
                ]}
              />
              {tab === "transcript" && isChat && <TranscriptView endpoint={data.endpoint} req={data.request_body} res={data.response_body} />}
              {tab === "request" && <CodeBlock title="request_body" lang="json" code={prettyJson(data.request_body)} maxHeight={640} />}
              {tab === "response" && <CodeBlock title="response_body" lang="json" code={prettyJson(data.response_body)} maxHeight={640} />}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function PurgeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const n = Number(days);
  const valid = days !== "" && !isNaN(n) && n >= 0;

  const go = async () => {
    if (!valid) return;
    if (n === 0) {
      const ok = await confirm({ title: "Delete ALL logs?", body: "Every request log, including this month's usage history, will be removed. Spend totals and budgets are computed from logs, so they reset too.", confirmLabel: "Delete everything", danger: true, typeToConfirm: "delete all" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.del<{ deleted: number }>(`/api/logs${qs({ older_than_days: n })}`);
      toast.ok(`Deleted ${int(r.deleted)} log entries`);
      onDone();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Purge logs"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!valid || busy} onClick={go}>
            {busy && <Spinner />} Purge
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Delete logs older than (days)" htmlFor="purge-days" hint="0 deletes everything. Spend and budget figures are derived from logs — purging old months doesn't affect the current month.">
          <input id="purge-days" className="input mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <div className="xs muted">Automatic retention is configured in Settings → Gateway (log retention days).</div>
      </div>
    </Modal>
  );
}
