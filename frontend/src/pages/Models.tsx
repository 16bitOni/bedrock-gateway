import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Boxes, Copy, FlaskConical, Plus, RefreshCw, ScrollText, Search, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, qs } from "../api";
import type { CatalogModel, ModelsResponse, SyncResult } from "../types";
import { useAsync, useDocumentTitle, useNow } from "../hooks";
import { compact, money, price, relTime } from "../format";
import { Banner, CopyButton, Empty, ErrorBanner, Field, Menu, Modal, PageHeader, SkeletonRows, Spinner, Switch, Tabs, copyText } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { invalidateV1Models } from "../components/ModelPicker";
import { AliasesTab } from "./Aliases";
import { PresetsTab } from "./Presets";
import { storage } from "../storage";

type TopTab = "models" | "aliases" | "presets";

export function Models() {
  useDocumentTitle("Models");
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as TopTab) || "models";
  const setTab = (t: TopTab) => {
    const n = new URLSearchParams();
    if (t !== "models") n.set("tab", t);
    setSearch(n, { replace: true });
  };
  return (
    <div className="page wide">
      <PageHeader title="Models" sub="Bedrock catalog, friendly aliases with fallback chains, and reusable presets." />
      <div className="mb-12">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "models", label: "Catalog" },
            { value: "aliases", label: "Aliases" },
            { value: "presets", label: "Presets" },
          ]}
        />
      </div>
      {tab === "models" && <CatalogTab />}
      {tab === "aliases" && <AliasesTab />}
      {tab === "presets" && <PresetsTab />}
    </div>
  );
}

export const ROUTE_LABEL: Record<string, { label: string; cls: string; title: string }> = {
  on_demand: { label: "in-region", cls: "", title: "On-demand in your configured region" },
  profile_global: { label: "global", cls: "ok", title: "Global cross-region inference profile (usually cheapest for Claude 4.5+)" },
  profile_geo: { label: "geo", cls: "info", title: "Geographic cross-region inference profile (us./eu./apac.)" },
  application_profile: { label: "app profile", cls: "accent", title: "Application inference profile (cost allocation tags)" },
  virtual: { label: "virtual", cls: "ghost", title: "Gateway-provided model (Polly / Transcribe)" },
  custom: { label: "custom", cls: "warn", title: "Added manually" },
};

export function RouteBadge({ route }: { route: string }) {
  const r = ROUTE_LABEL[route] || { label: route, cls: "", title: route };
  return (
    <span className={`badge ${r.cls}`} title={r.title}>
      {r.label}
    </span>
  );
}

export function priceText(m: CatalogModel): string {
  const p = m.price;
  if (!p) return "—";
  if (p.per_image) return `${price(p.per_image)}/img`;
  if (p.per_1k_queries) return `${price(p.per_1k_queries)}/1k q`;
  if (p.per_1m_chars) return `${price(p.per_1m_chars)}/1M ch`;
  if (p.per_minute) return `${price(p.per_minute)}/min`;
  if (m.kind === "embedding" || !p.output_per_m) return `${price(p.input_per_m)} in`;
  return `${price(p.input_per_m)} / ${price(p.output_per_m)}`;
}

const KINDS = ["chat", "embedding", "image", "rerank", "speech", "transcription", "realtime", "video", "other"];

function CatalogTab() {
  const { data, error, loading, reload, setData } = useAsync((signal) => api.get<ModelsResponse>("/api/models", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const now = useNow();
  const [kind, setKind] = useState<string>(() => storage.get("portal.models.kind") || "all");
  const [provider, setProvider] = useState("");
  const [route, setRoute] = useState("");
  const [q, setQ] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(() => storage.get("portal.models.enabledOnly") === "1");
  const [sort, setSort] = useState<"default" | "usage" | "price">("default");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [access, setAccess] = useState<{ id: string; loading: boolean; data?: Record<string, unknown>; error?: string } | null>(null);

  const rows = data?.data || [];
  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))].sort(), [rows]);
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) if (!enabledOnly || r.enabled) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }, [rows, enabledOnly]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter(
      (r) =>
        (kind === "all" || r.kind === kind) &&
        (!provider || r.provider === provider) &&
        (!route || r.route === route) &&
        (!enabledOnly || r.enabled) &&
        (!needle || r.id.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || r.aliases.some((a) => a.includes(needle))),
    );
    if (sort === "usage") out = [...out].sort((a, b) => b.month_cost - a.month_cost || b.month_requests - a.month_requests);
    if (sort === "price") out = [...out].sort((a, b) => (a.price?.input_per_m ?? 1e9) - (b.price?.input_per_m ?? 1e9));
    return out;
  }, [rows, kind, provider, route, enabledOnly, q, sort]);

  const enabledCount = rows.filter((r) => r.enabled).length;

  const patchRow = (id: string, patch: Partial<CatalogModel>) =>
    setData((d) => (d ? { ...d, data: d.data.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : d));

  const toggle = async (m: CatalogModel, enabled: boolean) => {
    patchRow(m.id, { enabled: enabled ? 1 : 0 });
    try {
      await api.patch("/api/models", { id: m.id, enabled });
      invalidateV1Models();
    } catch (e) {
      patchRow(m.id, { enabled: m.enabled });
      toast.err(errorMessage(e));
    }
  };

  const bulk = async (enabled: boolean) => {
    const ids = [...selected];
    try {
      await api.post("/api/models/bulk", { ids, enabled });
      setData((d) => (d ? { ...d, data: d.data.map((r) => (selected.has(r.id) ? { ...r, enabled: enabled ? 1 : 0 } : r)) } : d));
      toast.ok(`${enabled ? "Enabled" : "Disabled"} ${ids.length} model${ids.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      invalidateV1Models();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

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
    } finally {
      setSyncing(false);
    }
  };

  const checkAccess = async (id: string) => {
    setAccess({ id, loading: true });
    try {
      const r = await api.get<Record<string, unknown>>(`/api/models/availability${qs({ id })}`);
      setAccess({ id, loading: false, data: r });
    } catch (e) {
      setAccess({ id, loading: false, error: errorMessage(e) });
    }
  };

  const remove = async (m: CatalogModel) => {
    const ok = await confirm({ title: "Delete custom model?", body: <>Remove <code className="mono">{m.id}</code> from the catalog. Aliases pointing to it will fail over to their next target.</>, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/models${qs({ id: m.id })}`);
      setData((d) => (d ? { ...d, data: d.data.filter((r) => r.id !== m.id) } : d));
      toast.ok("Custom model deleted");
      invalidateV1Models();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const allShownSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const notSynced = data && !data.synced_at;

  return (
    <div className="col gap-12">
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {syncErr && <ErrorBanner title="Sync failed" error={syncErr} />}
      {notSynced && !loading && (
        <Banner
          kind="accent"
          title="The catalog hasn't been synced from AWS yet"
          action={
            <button className="btn primary sm" onClick={sync} disabled={syncing}>
              {syncing ? <Spinner /> : <RefreshCw />} Sync now
            </button>
          }
        >
          Only the built-in Polly / Transcribe models are listed. Configure credentials in <Link className="link" to="/settings#aws">Settings → AWS</Link>, then sync to import every
          foundation model and inference profile available in your region.
        </Banner>
      )}
      <div className="card">
        <div className="toolbar" style={{ paddingBottom: 0, borderBottom: 0 }}>
          <div className="input-group">
            <Search />
            <input className="input" placeholder="Search id, name or alias…" aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="select" aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select className="select" aria-label="Route" value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">All routes</option>
            {Object.entries(ROUTE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="default">Sort: provider</option>
            <option value="usage">Sort: month spend</option>
            <option value="price">Sort: input price</option>
          </select>
          <label className="check">
            <Switch
              checked={enabledOnly}
              onChange={(v) => {
                setEnabledOnly(v);
                storage.set("portal.models.enabledOnly", v ? "1" : "0");
              }}
              label="Enabled only"
            />
            Enabled only
          </label>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setShowAdd(true)}>
            <Plus /> Custom id
          </button>
          <button className="btn sm primary" onClick={sync} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw />} Sync from AWS
          </button>
        </div>
        <div style={{ padding: "0 4px" }}>
          <Tabs
            value={kind}
            onChange={(k) => {
              setKind(k);
              storage.set("portal.models.kind", k);
            }}
            tabs={[
              { value: "all", label: "All", count: Object.values(kindCounts).reduce((a, b) => a + b, 0) },
              ...KINDS.filter((k) => kindCounts[k]).map((k) => ({ value: k, label: k, count: kindCounts[k] })),
            ]}
          />
        </div>
        <div className="row wrap small muted" style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", minHeight: 40 }}>
          {selected.size > 0 ? (
            <>
              <span className="text-2">
                <b>{selected.size}</b> selected
              </span>
              <button className="btn xs" onClick={() => bulk(true)}>
                Enable
              </button>
              <button className="btn xs" onClick={() => bulk(false)}>
                Disable
              </button>
              <button className="btn ghost xs" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <span>
              {data ? (
                <>
                  <span className="mono">{filtered.length}</span> shown · <span className="mono">{enabledCount}</span> enabled of <span className="mono">{rows.length}</span> · region{" "}
                  <span className="mono">{data.region}</span> · synced {data.synced_at ? relTime(data.synced_at, now) : "never"}
                </>
              ) : (
                "Loading catalog…"
              )}
            </span>
          )}
          <span className="spacer" />
          <span className="xs faint">Prices per 1M tokens in / out</span>
        </div>
        {loading && !data ? (
          <SkeletonRows rows={10} cols={6} />
        ) : filtered.length === 0 ? (
          <Empty
            icon={<Boxes />}
            title={rows.length ? "No models match these filters" : "No models yet"}
            text={rows.length ? "Try clearing the search or switching tabs." : "Sync the catalog from AWS to import Bedrock foundation models and inference profiles."}
            action={
              rows.length ? (
                <button
                  className="btn sm"
                  onClick={() => {
                    setQ("");
                    setProvider("");
                    setRoute("");
                    setKind("all");
                    setEnabledOnly(false);
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button className="btn primary sm" onClick={sync} disabled={syncing}>
                  {syncing ? <Spinner /> : <RefreshCw />} Sync from AWS
                </button>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="check-col">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={allShownSelected}
                      onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...filtered.map((r) => r.id)]) : new Set([...selected].filter((id) => !filtered.some((r) => r.id === id))))}
                      style={{ accentColor: "var(--accent)" }}
                    />
                  </th>
                  <th style={{ width: 40 }}>On</th>
                  <th>Model</th>
                  <th className="hide-sm">Provider</th>
                  <th className="hide-sm">Kind</th>
                  <th>Route</th>
                  <th className="num">Price</th>
                  <th className="hide-sm">Aliases</th>
                  <th className="num hide-sm">Month</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id} className={selected.has(m.id) ? "selected" : undefined}>
                    <td className="check-col">
                      <input
                        type="checkbox"
                        aria-label={`Select ${m.id}`}
                        checked={selected.has(m.id)}
                        style={{ accentColor: "var(--accent)" }}
                        onChange={(e) => {
                          const s = new Set(selected);
                          if (e.target.checked) s.add(m.id);
                          else s.delete(m.id);
                          setSelected(s);
                        }}
                      />
                    </td>
                    <td>
                      <Switch checked={!!m.enabled} onChange={(v) => toggle(m, v)} label={`Enable ${m.id}`} />
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      <div className="cell-stack">
                        <span className="row gap-4">
                          <span className="mono truncate" style={{ fontSize: 12 }} title={m.id}>
                            {m.id}
                          </span>
                          <CopyButton text={m.id} />
                        </span>
                        <span className="cell-sub truncate" title={m.name}>
                          {m.name}
                          {m.lifecycle !== "ACTIVE" && <span className="warn-text"> · {m.lifecycle.toLowerCase()}</span>}
                          {m.input_modalities.includes("IMAGE") && m.kind === "chat" && <span> · vision</span>}
                        </span>
                      </div>
                    </td>
                    <td className="muted hide-sm">{m.provider}</td>
                    <td className="hide-sm">
                      <span className="badge ghost">{m.kind}</span>
                    </td>
                    <td>
                      <RouteBadge route={m.route} />
                    </td>
                    <td className="num" title={m.price ? `matched price prefix: ${m.price.matched_prefix}${m.price.markup_applied ? " (geo markup applied)" : ""}` : "No price configured — add one in Settings → Pricing"}>
                      {m.price ? priceText(m) : <span className="faint">no price</span>}
                    </td>
                    <td className="hide-sm" style={{ maxWidth: 170 }}>
                      <div className="chips" style={{ flexWrap: "nowrap", overflow: "hidden" }}>
                        {m.aliases.slice(0, 2).map((a) => (
                          <span key={a} className="chip">
                            {a}
                          </span>
                        ))}
                        {m.aliases.length > 2 && <span className="chip" title={m.aliases.join(", ")}>+{m.aliases.length - 2}</span>}
                      </div>
                    </td>
                    <td className="num hide-sm">
                      {m.month_requests ? (
                        <div className="cell-stack" style={{ alignItems: "flex-end" }}>
                          <span>{money(m.month_cost)}</span>
                          <span className="cell-sub">{compact(m.month_requests)} req</span>
                        </div>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="actions">
                      <ModelRowMenu
                        m={m}
                        onTry={() => navigate(`/playground?mode=${m.kind === "image" ? "image" : m.kind === "embedding" ? "embeddings" : m.kind === "rerank" ? "rerank" : m.kind === "speech" ? "speech" : "chat"}`)}
                        onCheck={() => checkAccess(m.id)}
                        onDelete={() => remove(m)}
                        onCopy={async () => {
                          if (await copyText(m.id)) toast.ok("Copied model id");
                        }}
                        onLogs={() => navigate(`/logs${qs({ model: m.id })}`)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showAdd && (
        <AddCustomDialog
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            invalidateV1Models();
            void reload();
          }}
        />
      )}
      {access && <AccessDialog state={access} onClose={() => setAccess(null)} />}
    </div>
  );
}

function ModelRowMenu({ m, onTry, onCheck, onDelete, onCopy, onLogs }: { m: CatalogModel; onTry: () => void; onCheck: () => void; onDelete: () => void; onCopy: () => void; onLogs: () => void }) {
  const tryable = ["chat", "image", "embedding", "rerank", "speech"].includes(m.kind);
  return (
    <Menu>
      {(close) => (
        <>
          {tryable && (
            <button
              role="menuitem"
              onClick={() => {
                close();
                if (m.kind === "chat") storage.set("portal.pg.model", m.id);
                if (m.kind === "image") storage.set("portal.img.model", m.id);
                if (m.kind === "embedding") storage.set("portal.emb.model", m.id);
                if (m.kind === "rerank") storage.set("portal.rr.model", m.id);
                if (m.kind === "speech") storage.set("portal.tts.model", m.id);
                onTry();
              }}
            >
              <FlaskConical /> Try in playground
            </button>
          )}
          {m.source !== "builtin" && (
            <button
              role="menuitem"
              onClick={() => {
                close();
                onCheck();
              }}
            >
              <ShieldCheck /> Check access
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              close();
              onCopy();
            }}
          >
            <Copy /> Copy id
          </button>
          <button
            role="menuitem"
            onClick={() => {
              close();
              onLogs();
            }}
          >
            <ScrollText /> View logs
          </button>
          {m.source === "custom" && (
            <>
              <hr />
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  close();
                  onDelete();
                }}
              >
                <Trash2 /> Delete
              </button>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

function AddCustomDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("chat");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim()) {
      setErr("Model id is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/models/custom", { id: id.trim(), name: name.trim() || undefined, kind });
      toast.ok(`Added ${id.trim()}`);
      onAdded();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add custom model id"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="add-custom" disabled={busy}>
            {busy && <Spinner />} Add model
          </button>
        </>
      }
    >
      <form id="add-custom" className="col gap-12" onSubmit={submit}>
        <p className="small muted">
          For models the sync didn't pick up: new releases, provisioned throughput, imported models or application inference profile ARNs. Bedrock validates the id on first use.
        </p>
        {err && <ErrorBanner error={err} />}
        <Field label="Model id / ARN" htmlFor="cm-id">
          <input id="cm-id" className="input mono" autoFocus placeholder="us.anthropic.claude-sonnet-5-5-v1:0" value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Display name" htmlFor="cm-name">
            <input id="cm-name" className="input" placeholder="optional" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Kind" htmlFor="cm-kind">
            <select id="cm-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {["chat", "embedding", "image", "rerank"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function statusTone(v: unknown): string {
  const s = String(v || "").toUpperCase();
  if (/NOT|DENIED|UNAVAILABLE|FAIL|ERROR|EXPIRED|REVOKED/.test(s)) return "err";
  if (/PENDING|UNKNOWN|PROGRESS/.test(s)) return "warn";
  if (/AVAILABLE|AUTHORIZED|SUCCE|ACTIVE/.test(s)) return "ok";
  return "";
}

function AccessDialog({ state, onClose }: { state: { id: string; loading: boolean; data?: Record<string, unknown>; error?: string }; onClose: () => void }) {
  const rows: { k: string; v: unknown; msg?: string }[] = [];
  if (state.data) {
    for (const [k, v] of Object.entries(state.data)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        rows.push({ k, v: o.status ?? JSON.stringify(o), msg: typeof o.errorMessage === "string" ? o.errorMessage : undefined });
      } else rows.push({ k, v });
    }
  }
  const pretty = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  return (
    <Modal title="Model access" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="col gap-12">
        <div className="mono small break">{state.id}</div>
        {state.loading && (
          <div className="row muted">
            <Spinner /> Checking with Bedrock…
          </div>
        )}
        {state.error && <ErrorBanner error={state.error} />}
        {state.data && (
          <dl className="kv">
            {rows.map((r) => (
              <div key={r.k} style={{ display: "contents" }}>
                <dt>{pretty(r.k)}</dt>
                <dd>
                  <span className={`badge ${statusTone(r.v)}`}>{String(r.v)}</span>
                  {r.msg && <div className="xs muted mt-4">{r.msg}</div>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {state.data && (
          <div className="xs muted">
            Anthropic models need the one-time use-case form in the Bedrock console. Marketplace models (non-Amazon/Anthropic) are subscribed automatically on first use when the role has{" "}
            <code className="mono">aws-marketplace:Subscribe</code>.
          </div>
        )}
      </div>
    </Modal>
  );
}
