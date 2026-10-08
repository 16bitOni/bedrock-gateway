import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, CircleDollarSign, Cloud, LogOut, Mic, RefreshCw, Server, ShieldCheck, Tags, Trash2, User, XCircle } from "lucide-react";
import { api, errorMessage, setToken } from "../api";
import type { AuthMode, IamInfo, Settings, SyncResult, TestAwsResult, TokenResponse } from "../types";
import { useAsync, useDocumentTitle } from "../hooks";
import { int } from "../format";
import { Banner, CodeBlock, CopyButton, ErrorBanner, Field, PageHeader, Skeleton, Spinner, Switch, Tabs } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { ModelPicker, invalidateV1Models, useV1Models } from "../components/ModelPicker";
import { useInfo } from "../components/Layout";
import { PricingTable } from "./Pricing";

const REGIONS: [string, string][] = [
  ["us-east-1", "US East (N. Virginia)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-west-2", "US West (Oregon)"],
  ["ca-central-1", "Canada (Central)"],
  ["sa-east-1", "South America (São Paulo)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-north-1", "Europe (Stockholm)"],
  ["ap-south-1", "Asia Pacific (Mumbai)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-southeast-2", "Asia Pacific (Sydney)"],
];

const AUTH_MODES: { value: AuthMode; title: string; text: string }[] = [
  { value: "assume_role", title: "Assume IAM role", text: "Recommended. The gateway assumes a least-privilege role (with an External ID) using its own base credentials. Temporary credentials refresh automatically." },
  { value: "default_chain", title: "Default credential chain", text: "Use whatever the host provides: env vars, ~/.aws profile, SSO, EC2/ECS/Lambda instance role." },
  { value: "static_keys", title: "Static access keys", text: "An IAM user's access key pair stored in the gateway database. Simplest, but long-lived — prefer a role." },
];

const SECTIONS = [
  { id: "aws", label: "AWS connection", icon: Cloud },
  { id: "gateway", label: "Gateway", icon: Server },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "billing", label: "Billing", icon: CircleDollarSign },
  { id: "pricing", label: "Pricing", icon: Tags },
  { id: "account", label: "Account", icon: User },
];

type Draft = Partial<Settings> & { aws_secret_access_key?: string };

function NumInput({ id, value, onChange, nullable, min, max, step, placeholder }: { id?: string; value: number | null | undefined; onChange: (v: number | null) => void; nullable?: boolean; min?: number; max?: number; step?: number; placeholder?: string }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => {
    const cur = text === "" ? null : Number(text);
    if (cur !== value) setText(value === null || value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      className="input mono"
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") {
          if (nullable) onChange(null);
          return;
        }
        const n = Number(t);
        if (!isNaN(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(step === 1 ? Math.round(n) : n);
      }}
    />
  );
}

export function SettingsPage({ onSignOut }: { onSignOut: () => void }) {
  useDocumentTitle("Settings");
  const toast = useToast();
  const loc = useLocation();
  const { refreshInfo } = useInfo();
  const { data, error, loading, reload, setData } = useAsync((signal) => api.get<Settings>("/api/settings", { signal }), []);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [active, setActive] = useState("aws");

  const merged = useMemo(() => ({ ...(data || {}), ...draft }) as Settings & { aws_secret_access_key?: string }, [data, draft]);
  const dirtyKeys = Object.keys(draft).filter((k) => (k === "aws_secret_access_key" ? !!draft.aws_secret_access_key : (draft as Record<string, unknown>)[k] !== (data as Record<string, unknown> | null)?.[k]));
  const dirty = dirtyKeys.length > 0;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Scroll to #section after load
  useEffect(() => {
    if (!data) return;
    const id = loc.hash.replace("#", "");
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActive(id);
      }
    }
  }, [data, loc.hash]);

  // Track the visible section for the nav
  useEffect(() => {
    if (!data) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [data]);

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setSaving(true);
    setSaveErr(null);
    const body: Record<string, unknown> = {};
    for (const k of dirtyKeys) body[k] = (draft as Record<string, unknown>)[k];
    try {
      const r = await api.put<Settings>("/api/settings", body);
      setData(r);
      setDraft({});
      toast.ok("Settings saved");
      if (dirtyKeys.some((k) => k === "aws_region" || k === "public_base_url")) refreshInfo();
      return true;
    } catch (e) {
      setSaveErr(errorMessage(e));
      toast.err("Couldn't save settings");
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="Settings" />
        {error ? <ErrorBanner error={error} onRetry={reload} /> : <Skeleton h={300} />}
        {loading && null}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Settings" sub="Stored in the gateway database. Changes apply immediately — no restart needed." />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={active === s.id ? "active" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                window.history.replaceState(null, "", `#${s.id}`);
                setActive(s.id);
              }}
            >
              <s.icon /> {s.label}
            </a>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <AwsSection s={merged} set={set} saved={data} dirtyAws={dirtyKeys.some((k) => k.startsWith("aws_"))} save={save} />
          <GatewaySection s={merged} set={set} />
          <VoiceSection s={merged} set={set} />
          <BillingSection s={merged} set={set} />
          <section id="pricing" className="settings-section">
            <PricingTable />
          </section>
          <AccountSection onSignOut={onSignOut} />
          {dirty && (
            <div className="save-bar" role="region" aria-label="Unsaved changes">
              <span className="small grow">
                {saveErr ? <span className="err-text">{saveErr}</span> : <>{dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? "" : "s"}</>}
              </span>
              <button className="btn sm" onClick={() => setDraft({})} disabled={saving}>
                Discard
              </button>
              <button className="btn sm primary" onClick={() => void save()} disabled={saving}>
                {saving && <Spinner />} Save changes
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type SectionProps = { s: Settings & { aws_secret_access_key?: string }; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void };

function Section({ id, title, sub, children, actions }: { id: string; title: string; sub?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section id={id} className="settings-section card">
      <div className="card-header">
        <div className="grow">
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {actions}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- AWS

function AwsSection({ s, set, saved, dirtyAws, save }: SectionProps & { saved: Settings; dirtyAws: boolean; save: () => Promise<boolean> }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestAwsResult | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const iam = useAsync((signal) => api.get<IamInfo>("/api/settings/iam", { signal }), []);
  const [policyTab, setPolicyTab] = useState<"cfn" | "permissions" | "trust">("cfn");

  const runTest = async () => {
    if (dirtyAws && !(await save())) return;
    setTesting(true);
    setTest(null);
    setTestErr(null);
    try {
      setTest(await api.post<TestAwsResult>("/api/settings/test-aws"));
    } catch (e) {
      setTestErr(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.post<SyncResult>("/api/models/sync");
      setSyncMsg({ ok: true, text: `Imported ${r.models} models (${r.enabled} enabled) and created ${r.aliases_created} aliases.` });
      toast.ok("Model catalog synced");
      invalidateV1Models();
    } catch (e) {
      setSyncMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setSyncing(false);
    }
  };

  const regionKnown = REGIONS.some(([r]) => r === s.aws_region);
  const ext = iam.data?.external_id || s.aws_external_id;
  const cfnFile = iam.data?.cloudformation_template || "infra/bedrock-portal-role.yaml";
  const deployCmd = `aws cloudformation deploy \\
  --template-file ${cfnFile} \\
  --stack-name bedrock-portal-role \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --parameter-overrides ExternalId=${ext}

aws cloudformation describe-stacks --stack-name bedrock-portal-role \\
  --query "Stacks[0].Outputs" --output table`;

  const testOk = test && test.ok !== false && test.identity;

  return (
    <Section id="aws" title="AWS connection" sub="How the gateway authenticates to Amazon Bedrock, Polly and Cost Explorer.">
      <div className="col gap-16">
        <div className="grid grid-3" role="radiogroup" aria-label="Authentication mode">
          {AUTH_MODES.map((m) => {
            const on = s.aws_auth_mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                className="card card-pad choice-card"
                style={{ borderColor: on ? "var(--accent)" : undefined, background: on ? "var(--accent-soft)" : undefined }}
                onClick={() => set("aws_auth_mode", m.value)}
              >
                <div className="row">
                  <span className="dot" style={{ background: on ? "var(--accent)" : undefined }} />
                  <span className="small" style={{ fontWeight: 600 }}>
                    {m.title}
                  </span>
                </div>
                <div className="xs muted mt-4">{m.text}</div>
              </button>
            );
          })}
        </div>

        <div className="form-grid">
          <Field label="Region" htmlFor="s-region" hint="Bedrock region for model calls and the catalog. Cross-region profiles (global./us./eu.) route from here.">
            <select id="s-region" className="select" value={s.aws_region} onChange={(e) => set("aws_region", e.target.value)}>
              {!regionKnown && <option value={s.aws_region}>{s.aws_region}</option>}
              {REGIONS.map(([r, n]) => (
                <option key={r} value={r}>
                  {r} — {n}
                </option>
              ))}
            </select>
          </Field>
          {s.aws_auth_mode !== "static_keys" && (
            <Field label="Source profile" htmlFor="s-profile" hint={s.aws_auth_mode === "assume_role" ? "Optional named profile for the base credentials that assume the role." : "Optional named profile from ~/.aws/config. Empty = default chain."}>
              <input id="s-profile" className="input mono" placeholder="default" value={s.aws_profile || ""} onChange={(e) => set("aws_profile", e.target.value)} />
            </Field>
          )}
          {s.aws_auth_mode === "assume_role" && (
            <>
              <Field label="Role ARN" htmlFor="s-role" className="span-2" hint="The RoleArn output of the CloudFormation stack.">
                <input id="s-role" className="input mono" placeholder="arn:aws:iam::123456789012:role/bedrock-portal" value={s.aws_role_arn || ""} onChange={(e) => set("aws_role_arn", e.target.value)} />
              </Field>
              <Field label="External ID" hint="Generated for this gateway. Put it in the role's trust policy (the template does this).">
                <div className="row gap-4">
                  <input className="input mono" readOnly value={ext} aria-label="External ID" />
                  <CopyButton text={ext} size="sm" ghost={false} />
                </div>
              </Field>
              <Field label="Session duration (seconds)" htmlFor="s-dur" hint="900–43200; the role's max session duration must allow it.">
                <NumInput id="s-dur" value={s.aws_session_duration} min={900} max={43200} step={1} onChange={(v) => v !== null && set("aws_session_duration", v)} />
              </Field>
            </>
          )}
          {s.aws_auth_mode === "static_keys" && (
            <>
              <Field label="Access key ID" htmlFor="s-akid">
                <input id="s-akid" className="input mono" autoComplete="off" placeholder="AKIA…" value={s.aws_access_key_id || ""} onChange={(e) => set("aws_access_key_id", e.target.value)} />
              </Field>
              <Field label="Secret access key" htmlFor="s-secret" hint={saved.aws_secret_access_key_set ? "A secret is stored. Leave empty to keep it." : "Never returned by the API once saved."}>
                <input
                  id="s-secret"
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  placeholder={saved.aws_secret_access_key_set ? "•••••••••••• (stored)" : ""}
                  value={s.aws_secret_access_key || ""}
                  onChange={(e) => set("aws_secret_access_key", e.target.value)}
                />
              </Field>
            </>
          )}
        </div>

        <div className="row wrap">
          <button className="btn primary" onClick={runTest} disabled={testing}>
            {testing ? <Spinner /> : <ShieldCheck />} {dirtyAws ? "Save & test connection" : "Test connection"}
          </button>
          <button className="btn" onClick={sync} disabled={syncing || dirtyAws} title={dirtyAws ? "Save AWS changes first" : undefined}>
            {syncing ? <Spinner /> : <RefreshCw />} Sync models
          </button>
          {saved.catalog_synced_at ? <span className="xs muted">Catalog last synced {new Date(saved.catalog_synced_at * 1000).toLocaleString()}</span> : <span className="xs muted">Catalog never synced</span>}
        </div>

        {testErr && <ErrorBanner error={testErr} />}
        {test && test.ok === false && (
          <Banner kind="err" title="Connection failed">
            <div className="break mono small">{test.error}</div>
            <div className="xs mt-4">
              Mode <code className="mono">{test.mode}</code> · region <code className="mono">{test.region}</code>.{" "}
              {s.aws_auth_mode === "assume_role"
                ? "Check the role ARN, that its trust policy allows your base credentials with this External ID, and that base credentials exist on this host."
                : s.aws_auth_mode === "static_keys"
                  ? "Check the access key pair and that the IAM user has the permissions policy below."
                  : "No usable credentials were found in the environment/profile, or they lack sts:GetCallerIdentity."}
            </div>
          </Banner>
        )}
        {testOk && test && (
          <div className="card card-pad col gap-8" style={{ borderColor: "color-mix(in srgb, var(--ok) 40%, var(--border))" }}>
            <div className="row">
              <CheckCircle2 size={15} className="ok-text" />
              <b className="small">Connected</b>
              <span className="xs muted">
                {int(test.foundation_models)} foundation models visible in {test.region}
              </span>
            </div>
            <dl className="kv">
              <dt>Account</dt>
              <dd className="mono small">{test.identity?.account}</dd>
              <dt>Identity</dt>
              <dd className="mono small">{test.identity?.arn}</dd>
              {Object.entries(test.checks || {}).map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k.replace(/_/g, " ")}</dt>
                  <dd className="small">
                    {v === "ok" ? (
                      <span className="row gap-4 ok-text">
                        <CheckCircle2 size={13} /> ok
                      </span>
                    ) : (
                      <span className="row gap-4 start warn-text">
                        <XCircle size={13} style={{ flex: "none", marginTop: 3 }} />
                        <span className="break">{v}</span>
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {syncMsg && (syncMsg.ok ? <Banner kind="info">{syncMsg.text}</Banner> : <ErrorBanner title="Sync failed" error={syncMsg.text} />)}

        <hr className="divider" style={{ margin: "4px 0" }} />
        <div className="col gap-12">
          <div className="small" style={{ fontWeight: 600 }}>
            Setup guide
          </div>
          <ol className="steps">
            <li>
              <div>
                <div className="step-title">Deploy the IAM role</div>
                <div className="step-text">
                  Deploy <code className="mono">{cfnFile}</code> with CloudFormation (console or CLI) using External ID <code className="mono">{ext}</code>. It creates a least-privilege role for Bedrock,
                  Polly, Transcribe and billing reads.
                </div>
                <div className="mt-8">
                  <CodeBlock title="AWS CLI" lang="sh" code={deployCmd} />
                </div>
                {iam.data?.cloudformation_yaml && (
                  <div className="mt-8">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        const blob = new Blob([iam.data!.cloudformation_yaml as string], { type: "text/yaml" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = "bedrock-portal-role.yaml";
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                      }}
                    >
                      Download template (for the CloudFormation console)
                    </button>
                  </div>
                )}
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Paste the RoleArn output</div>
                <div className="step-text">Choose “Assume IAM role” above, paste the ARN and save. The host running the gateway needs base credentials allowed to assume it.</div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Test the connection</div>
                <div className="step-text">Verifies STS identity, Bedrock catalog access, inference profiles, Polly and Cost Explorer.</div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Sync models</div>
                <div className="step-text">Imports foundation models and inference profiles for the region, enables one preferred route per model and creates default aliases.</div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Anthropic first-use form</div>
                <div className="step-text">
                  Claude models need a one-time use-case form: Bedrock console → Model catalog → any Anthropic model → submit the form. Other marketplace models are subscribed on first call.
                </div>
              </div>
            </li>
          </ol>
          <div className="card">
            <div style={{ padding: "0 6px" }}>
              <Tabs
                value={policyTab}
                onChange={setPolicyTab}
                tabs={[
                  { value: "cfn", label: "Without CloudFormation" },
                  { value: "permissions", label: "Permissions policy" },
                  { value: "trust", label: "Trust policy" },
                ]}
              />
            </div>
            <div className="card-body">
              {iam.error && <ErrorBanner error={iam.error} />}
              {policyTab === "cfn" && (
                <div className="col gap-8 small text-2">
                  <p>Prefer clicking through IAM yourself, or using static keys / the default chain?</p>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Create a role (or user) and attach the <b>permissions policy</b> as an inline policy.</li>
                    <li>
                      For a role, set the <b>trust policy</b> and replace <code className="mono">&lt;SOURCE_ACCOUNT_ID&gt;</code> with the account whose credentials run this gateway.
                    </li>
                    <li>Paste the role ARN above (or the access keys for a user) and test.</li>
                  </ol>
                </div>
              )}
              {policyTab === "permissions" && (iam.data ? <CodeBlock title="permissions-policy.json" lang="json" code={JSON.stringify(iam.data.permissions_policy, null, 2)} maxHeight={380} /> : <Skeleton h={200} />)}
              {policyTab === "trust" && (iam.data ? <CodeBlock title="trust-policy.json" lang="json" code={JSON.stringify(iam.data.trust_policy, null, 2)} maxHeight={380} /> : <Skeleton h={160} />)}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Gateway

function GatewaySection({ s, set }: SectionProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [clearing, setClearing] = useState(false);
  const clearCache = async () => {
    const ok = await confirm({ title: "Clear response cache?", body: "Cached responses are deleted; the next identical request goes to Bedrock again.", confirmLabel: "Clear cache" });
    if (!ok) return;
    setClearing(true);
    try {
      const r = await api.post<{ deleted: number }>("/api/cache/clear");
      toast.ok(`Cleared ${int(r.deleted)} cached responses`);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setClearing(false);
    }
  };
  return (
    <Section id="gateway" title="Gateway" sub="Defaults, retries, logging, caching and the global budget.">
      <div className="col gap-16">
        <div className="form-grid">
          <Field label="Default max tokens" htmlFor="g-mt" hint="Used when a request doesn't set max_tokens.">
            <NumInput id="g-mt" value={s.default_max_tokens} min={1} step={1} onChange={(v) => v !== null && set("default_max_tokens", v)} />
          </Field>
          <Field label="Retry attempts" htmlFor="g-retry" hint="Retries per target on throttling / 5xx before falling back to the next alias target.">
            <NumInput id="g-retry" value={s.retry_attempts} min={0} max={10} step={1} onChange={(v) => v !== null && set("retry_attempts", v)} />
          </Field>
          <Field label="Monthly budget (USD)" htmlFor="g-budget" hint="Global hard cap across all keys. Empty = unlimited.">
            <NumInput id="g-budget" value={s.monthly_budget_usd} nullable min={0} placeholder="unlimited" onChange={(v) => set("monthly_budget_usd", v)} />
          </Field>
          <Field label="Budget alert (%)" htmlFor="g-alert" hint="Budget bars turn amber past this point.">
            <NumInput id="g-alert" value={s.budget_alert_pct} min={1} max={100} step={1} onChange={(v) => v !== null && set("budget_alert_pct", v)} />
          </Field>
          <Field label="Log retention (days)" htmlFor="g-ret" hint="Older request logs are purged hourly. 0 = keep forever.">
            <NumInput id="g-ret" value={s.log_retention_days} min={0} step={1} onChange={(v) => v !== null && set("log_retention_days", v)} />
          </Field>
          <Field
            label="Response cache TTL (hours)"
            htmlFor="g-ttl"
            right={
              <button className="btn ghost xs" onClick={clearCache} disabled={clearing} type="button">
                {clearing ? <Spinner size={11} /> : <Trash2 />} Clear cache
              </button>
            }
          >
            <NumInput id="g-ttl" value={s.cache_ttl_hours} min={0} onChange={(v) => v !== null && set("cache_ttl_hours", v)} />
          </Field>
          <Field label="Public base URL" htmlFor="g-url" className="span-2" hint="Used in code snippets and generated image URLs. Empty = the URL you're browsing from.">
            <input id="g-url" className="input mono" placeholder="https://portal.example.com" value={s.public_base_url || ""} onChange={(e) => set("public_base_url", e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="switch-row">
            <div>
              <div className="small">Automatic prompt caching</div>
              <div className="xs muted">Adds Bedrock cache points to long system prompts and tool lists on supported models (Claude, Nova) — big savings for agents.</div>
            </div>
            <Switch checked={!!s.auto_prompt_cache} onChange={(v) => set("auto_prompt_cache", v)} label="Automatic prompt caching" />
          </div>
          <div className="switch-row">
            <div>
              <div className="small">Store request & response bodies</div>
              <div className="xs muted">Global switch for transcripts and replay. Keys can opt out individually. Large base64 payloads are always stripped.</div>
            </div>
            <Switch checked={!!s.log_bodies} onChange={(v) => set("log_bodies", v)} label="Store bodies" />
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Voice

function VoiceSection({ s, set }: SectionProps) {
  const { models } = useV1Models();
  return (
    <Section id="voice" title="Voice" sub="Text-to-speech (Amazon Polly) and speech-to-text defaults.">
      <div className="form-grid">
        <Field label="Default TTS engine" htmlFor="v-engine" hint="Used when /v1/audio/speech is called without a model.">
          <select id="v-engine" className="select" value={s.tts_default_engine} onChange={(e) => set("tts_default_engine", e.target.value)}>
            <option value="generative">generative — most natural</option>
            <option value="neural">neural — fast, cheaper</option>
            <option value="long-form">long-form — audiobooks</option>
            <option value="standard">standard — cheapest</option>
          </select>
        </Field>
        <Field label="Default STT model" htmlFor="v-stt" hint="Used when /v1/audio/transcriptions is called without a model.">
          <ModelPicker id="v-stt" value={s.stt_model || ""} onChange={(v) => set("stt_model", v)} models={models} kinds={["chat", "transcription"]} />
        </Field>
        <Field
          label="Amazon Transcribe S3 bucket"
          htmlFor="v-bucket"
          className="span-2"
          hint={<>Optional. Enables the <code className="mono">aws-transcribe</code> model (batch, speaker-grade accuracy, srt/vtt). Audio is uploaded temporarily and deleted afterwards.</>}
        >
          <input id="v-bucket" className="input mono" placeholder="my-transcribe-bucket" value={s.transcribe_s3_bucket || ""} onChange={(e) => set("transcribe_s3_bucket", e.target.value)} />
        </Field>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Billing

function BillingSection({ s, set }: SectionProps) {
  return (
    <Section id="billing" title="Billing" sub="Actual AWS spend and credits via Cost Explorer / Billing APIs.">
      <div className="col gap-12">
        <div className="switch-row" style={{ paddingTop: 0 }}>
          <div>
            <div className="small">AWS billing lookups</div>
            <div className="xs muted">Cost Explorer charges $0.01 per API call; a refresh makes ~3 calls. Data is cached and only refreshed on demand.</div>
          </div>
          <Switch checked={!!s.billing_enabled} onChange={(v) => set("billing_enabled", v)} label="AWS billing lookups" />
        </div>
        <div className="form-grid">
          <Field label="Billing cache (hours)" htmlFor="b-cache">
            <NumInput id="b-cache" value={s.billing_cache_hours} min={0} onChange={(v) => v !== null && set("billing_cache_hours", v)} />
          </Field>
          <Field label="Geo profile markup" htmlFor="b-markup" hint="Price multiplier for us./eu./apac. profiles vs global. on models flagged “geo” in the price table (AWS charges ~10% more).">
            <NumInput id="b-markup" value={s.geo_profile_markup} min={1} max={3} onChange={(v) => v !== null && set("geo_profile_markup", v)} />
          </Field>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Account

function AccountSection({ onSignOut }: { onSignOut: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [nw2, setNw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nw.length < 8) return setErr("New password must be at least 8 characters.");
    if (nw !== nw2) return setErr("New passwords don't match.");
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<TokenResponse>("/api/auth/password", { current: cur, new: nw });
      setToken(r.token);
      setCur("");
      setNw("");
      setNw2("");
      toast.ok("Password changed — other sessions were signed out");
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="account"
      title="Account"
      sub="The admin password protects this dashboard and the admin API."
      actions={
        <button className="btn sm" onClick={onSignOut}>
          <LogOut /> Sign out
        </button>
      }
    >
      <form className="col gap-12" onSubmit={change} style={{ maxWidth: 520 }}>
        {err && <ErrorBanner error={err} />}
        <Field label="Current password" htmlFor="a-cur">
          <input id="a-cur" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="New password" htmlFor="a-new">
            <input id="a-new" className="input" type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} placeholder="8+ characters" />
          </Field>
          <Field label="Confirm new password" htmlFor="a-new2">
            <input id="a-new2" className="input" type="password" autoComplete="new-password" value={nw2} onChange={(e) => setNw2(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy || !cur || !nw || !nw2}>
            {busy && <Spinner />} Change password
          </button>
          <span className="xs muted">Changing it signs out every other session.</span>
        </div>
      </form>
    </Section>
  );
}

