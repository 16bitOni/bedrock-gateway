import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Ban, CheckCircle2, KeyRound, Pencil, Plus, RotateCw, ScrollText, Trash2, X } from "lucide-react";
import { api, errorMessage, qs } from "../api";
import type { ApiKey } from "../types";
import { useAsync, useDocumentTitle, useNow } from "../hooks";
import { compact, dateOnly, dateTime, money, relTime } from "../format";
import { Banner, CodeBlock, CopyButton, Empty, ErrorBanner, Field, Menu, Modal, PageHeader, Progress, SkeletonRows, Spinner, Switch } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { ModelPicker, useV1Models } from "../components/ModelPicker";
import { useInfo } from "../components/Layout";

export function keyLabel(k: Pick<ApiKey, "prefix">): string {
  return `${k.prefix}…`;
}

function keyStatus(k: ApiKey, now: number): { label: string; cls: string } {
  if (k.disabled) return { label: "disabled", cls: "err" };
  if (k.expires_at && k.expires_at < now) return { label: "expired", cls: "err" };
  if (k.monthly_budget_usd !== null && k.month_spend >= k.monthly_budget_usd) return { label: "over budget", cls: "warn" };
  if (k.expires_at && k.expires_at - now < 7 * 86400) return { label: `expires ${relTime(k.expires_at, now)}`, cls: "warn" };
  return { label: "active", cls: "ok" };
}

export function Keys() {
  useDocumentTitle("API Keys");
  const { data, error, loading, reload, setData } = useAsync((signal) => api.get<{ data: ApiKey[] }>("/api/keys", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const now = useNow();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const [secret, setSecret] = useState<{ key: ApiKey; raw: string; rotated: boolean } | null>(null);

  const keys = data?.data || [];
  const totals = useMemo(() => keys.reduce((a, k) => ({ month: a.month + k.month_spend, req: a.req + k.month_requests }), { month: 0, req: 0 }), [keys]);

  const replace = (k: ApiKey) => setData((d) => (d ? { data: d.data.map((x) => (x.id === k.id ? k : x)) } : d));

  const rotate = async (k: ApiKey) => {
    const ok = await confirm({
      title: `Rotate “${k.name}”?`,
      body: "A new secret is generated and the current one stops working immediately. Settings, budget and usage history are kept.",
      confirmLabel: "Rotate key",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<ApiKey>(`/api/keys/${k.id}/rotate`);
      const raw = r.key || "";
      delete r.key;
      replace(r);
      setSecret({ key: r, raw, rotated: true });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const toggleDisabled = async (k: ApiKey) => {
    try {
      const r = await api.patch<ApiKey>(`/api/keys/${k.id}`, { disabled: !k.disabled });
      replace(r);
      toast.ok(r.disabled ? `Disabled ${k.name}` : `Enabled ${k.name}`);
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const remove = async (k: ApiKey) => {
    const ok = await confirm({
      title: `Delete “${k.name}”?`,
      body: "Apps using this key will get 401 errors. Its request logs are kept. This can't be undone.",
      confirmLabel: "Delete key",
      danger: true,
      typeToConfirm: k.name,
    });
    if (!ok) return;
    try {
      await api.del(`/api/keys/${k.id}`);
      setData((d) => (d ? { data: d.data.filter((x) => x.id !== k.id) } : d));
      toast.ok(`Deleted ${k.name}`);
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <PageHeader title="API Keys" sub={data ? `${keys.length} keys · ${money(totals.month)} and ${compact(totals.req)} requests this month` : "Keys for your projects — each with its own budget, rate limit and model allow-list."}>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus /> Create key
        </button>
      </PageHeader>
      <div className="col gap-12">
        <ErrorBanner error={error} onRetry={reload} />
        <div className="card">
          {loading && !data ? (
            <SkeletonRows rows={5} cols={6} />
          ) : keys.length === 0 ? (
            <Empty
              icon={<KeyRound />}
              title="No API keys yet"
              text="Create one key per project or app so spend, limits and logs stay separate. The secret is shown once."
              action={
                <button className="btn primary sm" onClick={() => setEditing("new")}>
                  <Plus /> Create your first key
                </button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="hide-sm">Key</th>
                    <th>Status</th>
                    <th className="hide-sm">Models</th>
                    <th style={{ minWidth: 170 }}>Month spend / budget</th>
                    <th className="hide-sm num">Req</th>
                    <th className="hide-sm num">Total</th>
                    <th className="hide-sm num">RPM</th>
                    <th className="hide-sm">Last used</th>
                    <th className="hide-sm">Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const st = keyStatus(k, now);
                    return (
                      <tr key={k.id}>
                        <td style={{ maxWidth: 220 }}>
                          <div className="cell-stack">
                            <span className="cell-main truncate">{k.name}</span>
                            <span className="cell-sub truncate" title={k.notes || ""}>
                              {k.notes || `created ${dateOnly(k.created_at)}`}
                            </span>
                          </div>
                        </td>
                        <td className="mono hide-sm">{keyLabel(k)}</td>
                        <td>
                          <div className="row gap-4">
                            <span className={`badge ${st.cls}`}>{st.label}</span>
                            {k.cache_enabled ? <span className="badge ghost" title="Exact-match response cache on">cache</span> : null}
                            {k.guardrail_id ? <span className="badge ghost" title={`Guardrail ${k.guardrail_id}:${k.guardrail_version || "DRAFT"}`}>guardrail</span> : null}
                            {!k.store_bodies ? <span className="badge ghost" title="Request/response bodies are not stored">no bodies</span> : null}
                          </div>
                        </td>
                        <td className="hide-sm" style={{ maxWidth: 180 }}>
                          {k.allowed_models.length ? (
                            <span className="truncate mono xs" style={{ display: "block" }} title={k.allowed_models.join(", ")}>
                              {k.allowed_models.length <= 2 ? k.allowed_models.join(", ") : `${k.allowed_models.slice(0, 2).join(", ")} +${k.allowed_models.length - 2}`}
                            </span>
                          ) : (
                            <span className="muted">all</span>
                          )}
                        </td>
                        <td>
                          <div className="col gap-4" style={{ minWidth: 150 }}>
                            <span className="mono xs">
                              {money(k.month_spend)}
                              <span className="muted"> / {k.monthly_budget_usd !== null ? money(k.monthly_budget_usd) : "∞"}</span>
                            </span>
                            {k.monthly_budget_usd !== null && <Progress value={k.month_spend} max={k.monthly_budget_usd} thin label={`${k.name} budget`} />}
                          </div>
                        </td>
                        <td className="num hide-sm">{compact(k.month_requests)}</td>
                        <td className="num hide-sm">{money(k.total_spend)}</td>
                        <td className="num hide-sm">{k.rpm_limit ?? <span className="faint">∞</span>}</td>
                        <td className="muted hide-sm" title={dateTime(k.last_used_at)}>
                          {relTime(k.last_used_at, now)}
                        </td>
                        <td className="muted hide-sm" title={dateTime(k.expires_at)}>
                          {k.expires_at ? dateOnly(k.expires_at) : "never"}
                        </td>
                        <td className="actions">
                          <div className="row gap-4" style={{ justifyContent: "flex-end" }}>
                            <button className="btn ghost icon sm" aria-label={`Edit ${k.name}`} title="Edit" onClick={() => setEditing(k)}>
                              <Pencil />
                            </button>
                            <Menu>
                              {(close) => (
                                <>
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      close();
                                      navigate(`/logs${qs({ key_id: k.id })}`);
                                    }}
                                  >
                                    <ScrollText /> View logs
                                  </button>
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      close();
                                      void toggleDisabled(k);
                                    }}
                                  >
                                    {k.disabled ? <CheckCircle2 /> : <Ban />} {k.disabled ? "Enable" : "Disable"}
                                  </button>
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      close();
                                      void rotate(k);
                                    }}
                                  >
                                    <RotateCw /> Rotate secret
                                  </button>
                                  <hr />
                                  <button
                                    role="menuitem"
                                    className="danger"
                                    onClick={() => {
                                      close();
                                      void remove(k);
                                    }}
                                  >
                                    <Trash2 /> Delete
                                  </button>
                                </>
                              )}
                            </Menu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="xs muted">
          The dashboard's own session also works on <code className="mono">/v1</code> as the built-in <b>Playground</b> key (id 0) — that's what the Playground uses.
        </div>
      </div>
      {editing && (
        <KeyEditor
          apiKey={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(k, raw) => {
            setEditing(null);
            if (raw) {
              setData((d) => (d ? { data: [k, ...d.data] } : { data: [k] }));
              setSecret({ key: k, raw, rotated: false });
            } else {
              replace(k);
              toast.ok(`Saved ${k.name}`);
            }
          }}
        />
      )}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function SecretModal({ secret, onClose }: { secret: { key: ApiKey; raw: string; rotated: boolean }; onClose: () => void }) {
  const { info } = useInfo();
  const base = info?.base_url || window.location.origin;
  const openai = info?.openai_base_url || `${base}/v1`;
  const env = `# OpenAI-compatible SDKs (Python, Node, LangChain, LlamaIndex, …)
OPENAI_BASE_URL=${openai}
OPENAI_API_KEY=${secret.raw}

# Anthropic SDK / Claude Code
ANTHROPIC_BASE_URL=${base}
ANTHROPIC_AUTH_TOKEN=${secret.raw}`;
  return (
    <Modal
      title={secret.rotated ? `New secret for “${secret.key.name}”` : `Key “${secret.key.name}” created`}
      size="lg"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          I've saved it
        </button>
      }
    >
      <div className="col gap-12">
        <Banner kind="warn" title="Copy it now — it won't be shown again">
          Only a hash is stored. If you lose it, rotate the key to get a new secret.
        </Banner>
        <div className="secret-box">
          <span className="grow">{secret.raw}</span>
          <CopyButton text={secret.raw} label="Copy" ghost={false} />
        </div>
        <CodeBlock title=".env" lang="sh" code={env} />
      </div>
    </Modal>
  );
}

type ExpiryMode = "keep" | "never" | "days";

function KeyEditor({ apiKey, onClose, onSaved }: { apiKey: ApiKey | null; onClose: () => void; onSaved: (k: ApiKey, raw?: string) => void }) {
  const { models } = useV1Models();
  const [name, setName] = useState(apiKey?.name || "");
  const [allowed, setAllowed] = useState<string[]>(apiKey?.allowed_models || []);
  const [budget, setBudget] = useState(apiKey?.monthly_budget_usd != null ? String(apiKey.monthly_budget_usd) : "");
  const [rpm, setRpm] = useState(apiKey?.rpm_limit != null ? String(apiKey.rpm_limit) : "");
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>(apiKey ? "keep" : "never");
  const [days, setDays] = useState("90");
  const [storeBodies, setStoreBodies] = useState(apiKey ? !!apiKey.store_bodies : true);
  const [cache, setCache] = useState(apiKey ? !!apiKey.cache_enabled : false);
  const [guardrailId, setGuardrailId] = useState(apiKey?.guardrail_id || "");
  const [guardrailVersion, setGuardrailVersion] = useState(apiKey?.guardrail_version || "");
  const [notes, setNotes] = useState(apiKey?.notes || "");
  const [disabled, setDisabled] = useState(apiKey ? !!apiKey.disabled : false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setErr("Name is required.");
    if (budget && (isNaN(Number(budget)) || Number(budget) < 0)) return setErr("Budget must be a positive number.");
    if (rpm && (!/^\d+$/.test(rpm) || Number(rpm) < 1)) return setErr("RPM limit must be a whole number ≥ 1.");
    if (expiryMode === "days" && (!/^\d+(\.\d+)?$/.test(days) || Number(days) <= 0)) return setErr("Expiry must be a positive number of days.");
    const body: Record<string, unknown> = {
      name: name.trim(),
      allowed_models: allowed,
      monthly_budget_usd: budget === "" ? null : Number(budget),
      rpm_limit: rpm === "" ? null : Number(rpm),
      store_bodies: storeBodies,
      cache_enabled: cache,
      guardrail_id: guardrailId.trim() || null,
      guardrail_version: guardrailId.trim() ? guardrailVersion.trim() || null : null,
      notes: notes.trim() || null,
    };
    if (expiryMode === "never") body.expires_in_days = null;
    if (expiryMode === "days") body.expires_in_days = Number(days);
    if (apiKey) body.disabled = disabled;
    setBusy(true);
    setErr(null);
    try {
      if (apiKey) {
        const r = await api.patch<ApiKey>(`/api/keys/${apiKey.id}`, body);
        onSaved(r);
      } else {
        const r = await api.post<ApiKey>("/api/keys", body);
        const raw = r.key || "";
        delete r.key;
        onSaved(r, raw);
      }
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  const pickerModels = models?.filter((m) => !allowed.includes(m.id)) ?? null;

  return (
    <Modal
      title={apiKey ? `Edit “${apiKey.name}”` : "Create API key"}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="key-form" disabled={busy}>
            {busy && <Spinner />} {apiKey ? "Save changes" : "Create key"}
          </button>
        </>
      }
    >
      <form id="key-form" className="col gap-16" onSubmit={save}>
        {err && <ErrorBanner error={err} />}
        <div className="form-grid">
          <Field label="Name" htmlFor="k-name" className="span-2">
            <input id="k-name" className="input" autoFocus={!apiKey} placeholder="my-agent-prod" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Allowed models" className="span-2" hint="Empty = every enabled model, alias and preset. Listing an alias also allows its targets.">
            {allowed.length > 0 && (
              <div className="chips">
                {allowed.map((m) => (
                  <span key={m} className="chip">
                    {m}
                    <button type="button" aria-label={`Remove ${m}`} onClick={() => setAllowed((a) => a.filter((x) => x !== m))}>
                      <X />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ModelPicker value="" placeholder={allowed.length ? "Add another model…" : "All models (click to restrict)"} models={pickerModels} onChange={(id) => id && setAllowed((a) => (a.includes(id) ? a : [...a, id]))} />
          </Field>
          <Field label="Monthly budget (USD)" htmlFor="k-budget" hint="Hard cap — requests get 429 once reached. Empty = unlimited.">
            <input id="k-budget" className="input mono" inputMode="decimal" placeholder="unlimited" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Field label="Rate limit (requests / minute)" htmlFor="k-rpm" hint="Empty = unlimited.">
            <input id="k-rpm" className="input mono" inputMode="numeric" placeholder="unlimited" value={rpm} onChange={(e) => setRpm(e.target.value)} />
          </Field>
          <Field
            label="Expiry"
            htmlFor="k-exp"
            hint={apiKey && expiryMode === "keep" ? (apiKey.expires_at ? `Currently expires ${dateTime(apiKey.expires_at)}.` : "Currently never expires.") : undefined}
          >
            <div className="row">
              <select id="k-exp" className="select" value={expiryMode} onChange={(e) => setExpiryMode(e.target.value as ExpiryMode)}>
                {apiKey && <option value="keep">Keep current</option>}
                <option value="never">Never</option>
                <option value="days">{apiKey ? "Expire in… (from now)" : "Expire in…"}</option>
              </select>
              {expiryMode === "days" && (
                <>
                  <input className="input mono" aria-label="Days until expiry" style={{ width: 80 }} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
                  <span className="small muted">days</span>
                </>
              )}
            </div>
          </Field>
          <Field label="Notes" htmlFor="k-notes">
            <input id="k-notes" className="input" placeholder="owner, repo, purpose…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="Bedrock guardrail id" htmlFor="k-gid" hint="Optional. Applied to every chat request from this key.">
            <input id="k-gid" className="input mono" placeholder="gr-abc123xyz" value={guardrailId} onChange={(e) => setGuardrailId(e.target.value)} />
          </Field>
          <Field label="Guardrail version" htmlFor="k-gv">
            <input id="k-gv" className="input mono" placeholder="DRAFT or 1" disabled={!guardrailId.trim()} value={guardrailVersion} onChange={(e) => setGuardrailVersion(e.target.value)} />
          </Field>
        </div>
        <div className="card card-pad" style={{ paddingTop: 2, paddingBottom: 2 }}>
          <div className="switch-row">
            <div>
              <div className="small">Store request & response bodies</div>
              <div className="xs muted">Needed for transcripts and replay in Logs. Turn off for sensitive data (metadata is still logged).</div>
            </div>
            <Switch checked={storeBodies} onChange={setStoreBodies} label="Store bodies" />
          </div>
          <div className="switch-row">
            <div>
              <div className="small">Response cache</div>
              <div className="xs muted">Identical non-streaming requests are served from cache for free. Clients can also opt in per call with <code className="mono">x-portal-cache: 1</code>.</div>
            </div>
            <Switch checked={cache} onChange={setCache} label="Response cache" />
          </div>
          {apiKey && (
            <div className="switch-row">
              <div>
                <div className="small">Disabled</div>
                <div className="xs muted">Requests with this key are rejected with 403 until re-enabled.</div>
              </div>
              <Switch checked={disabled} onChange={setDisabled} label="Disabled" />
            </div>
          )}
        </div>
        {!apiKey && (
          <div className="row xs muted">
            <AlertTriangle size={13} /> The secret is shown once after creation.
          </div>
        )}
      </form>
    </Modal>
  );
}
