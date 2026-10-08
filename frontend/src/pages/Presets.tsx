import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConical, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, errorMessage } from "../api";
import type { Preset } from "../types";
import { useAsync } from "../hooks";
import { Banner, CodeBlock, CopyButton, Empty, ErrorBanner, Field, Modal, SkeletonRows, Spinner } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { ModelPicker, invalidateV1Models, useV1Models } from "../components/ModelPicker";
import { storage } from "../storage";

const PARAM_TEMPLATE = `{
  "temperature": 0.2,
  "max_tokens": 2048,
  "reasoning_effort": "low"
}`;

export function PresetsTab() {
  const { data, error, loading, reload } = useAsync((signal) => api.get<{ data: Preset[] }>("/api/presets", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Preset | "new" | null>(null);

  const remove = async (p: Preset) => {
    const ok = await confirm({ title: `Delete preset “${p.name}”?`, body: <>Calls to <code className="mono">preset/{p.name}</code> will fail with model_not_found.</>, confirmLabel: "Delete preset", danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/presets/${encodeURIComponent(p.name)}`);
      toast.ok(`Deleted preset ${p.name}`);
      invalidateV1Models();
      void reload();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const list = data?.data || [];
  return (
    <div className="col gap-12">
      <ErrorBanner error={error} onRetry={reload} />
      <Banner kind="info" title="How presets work">
        A preset bundles a model, a system prompt and default parameters under one name. Call it with <code className="mono">model: "preset/&lt;name&gt;"</code>. The preset's system prompt
        is prepended to the request and its params apply unless the request sets them explicitly.
      </Banner>
      <div className="card">
        <div className="card-header">
          <SlidersHorizontal size={14} className="muted" />
          <div className="card-title grow">Presets</div>
          <button className="btn sm primary" onClick={() => setEditing("new")}>
            <Plus /> New preset
          </button>
        </div>
        {loading && !data ? (
          <SkeletonRows rows={4} cols={4} />
        ) : list.length === 0 ? (
          <Empty
            icon={<SlidersHorizontal />}
            title="No presets yet"
            text="Example: a “sql” preset on the coder alias with a strict system prompt and temperature 0 — then any client can call model “preset/sql”."
            action={
              <button className="btn sm" onClick={() => setEditing("new")}>
                Create a preset
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>System prompt</th>
                  <th>Params</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <div className="cell-stack">
                        <span className="row gap-4">
                          <span className="mono" style={{ fontWeight: 600 }}>
                            preset/{p.name}
                          </span>
                          <CopyButton text={`preset/${p.name}`} />
                        </span>
                        {p.description && <span className="cell-sub">{p.description}</span>}
                      </div>
                    </td>
                    <td className="mono">{p.model}</td>
                    <td className="muted" style={{ maxWidth: 320 }}>
                      <span className="truncate" style={{ display: "block" }} title={p.system_prompt || ""}>
                        {p.system_prompt || "—"}
                      </span>
                    </td>
                    <td>
                      <div className="chips" style={{ flexWrap: "nowrap" }}>
                        {Object.entries(p.params || {})
                          .slice(0, 4)
                          .map(([k, v]) => (
                            <span key={k} className="chip">
                              {k}={typeof v === "object" ? "{…}" : String(v)}
                            </span>
                          ))}
                        {!Object.keys(p.params || {}).length && <span className="faint">—</span>}
                      </div>
                    </td>
                    <td className="actions">
                      <div className="row gap-4" style={{ justifyContent: "flex-end" }}>
                        <Link
                          className="btn ghost icon sm"
                          aria-label={`Try ${p.name} in playground`}
                          title="Try in playground"
                          to="/playground"
                          onClick={() => storage.set("portal.pg.model", `preset/${p.name}`)}
                        >
                          <FlaskConical />
                        </Link>
                        <button className="btn ghost icon sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                          <Pencil />
                        </button>
                        <button className="btn ghost icon sm" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}>
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <PresetEditor
          preset={editing === "new" ? null : editing}
          existing={list.map((p) => p.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateV1Models();
            void reload();
          }}
        />
      )}
    </div>
  );
}

function PresetEditor({ preset, existing, onClose, onSaved }: { preset: Preset | null; existing: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { models } = useV1Models();
  const pickerModels = useMemo(() => models?.filter((m) => m.owned_by !== "preset") ?? null, [models]);
  const [name, setName] = useState(preset?.name || "");
  const [model, setModel] = useState(preset?.model || "");
  const [description, setDescription] = useState(preset?.description || "");
  const [system, setSystem] = useState(preset?.system_prompt || "");
  const [params, setParams] = useState(preset ? JSON.stringify(preset.params || {}, null, 2) : PARAM_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const paramsErr = useMemo(() => {
    if (!params.trim()) return null;
    try {
      const v = JSON.parse(params);
      if (!v || typeof v !== "object" || Array.isArray(v)) return "Params must be a JSON object.";
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [params]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const nm = name.trim().replace(/^preset\//, "");
    if (!nm) return setErr("Name is required.");
    if (/[\s/]/.test(nm)) return setErr("Preset names can't contain spaces or '/'.");
    if (!preset && existing.includes(nm)) return setErr(`A preset named “${nm}” already exists.`);
    if (!model) return setErr("Pick a model or alias.");
    if (paramsErr) return setErr(`Params: ${paramsErr}`);
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/presets/${encodeURIComponent(nm)}`, {
        model,
        system_prompt: system || null,
        params: params.trim() ? JSON.parse(params) : {},
        description: description.trim() || null,
      });
      toast.ok(`Saved preset/${nm}`);
      onSaved();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  const nm = name.trim() || "<name>";
  return (
    <Modal
      title={preset ? `Edit preset/${preset.name}` : "New preset"}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="preset-form" disabled={busy}>
            {busy && <Spinner />} Save preset
          </button>
        </>
      }
    >
      <form id="preset-form" className="col gap-12" onSubmit={save}>
        {err && <ErrorBanner error={err} />}
        <div className="form-grid">
          <Field label="Name" htmlFor="pr-name" hint={<>Called as <code className="mono">preset/{nm}</code></>}>
            <input id="pr-name" className="input mono" autoFocus={!preset} disabled={!!preset} value={name} placeholder="sql-helper" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Model or alias" htmlFor="pr-model">
            <ModelPicker id="pr-model" value={model} onChange={setModel} models={pickerModels} />
          </Field>
          <Field label="Description" htmlFor="pr-desc" className="span-2">
            <input id="pr-desc" className="input" value={description} placeholder="optional" onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="System prompt" htmlFor="pr-sys" className="span-2">
            <textarea id="pr-sys" className="textarea" rows={5} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are an expert PostgreSQL engineer. Answer with a single SQL query." />
          </Field>
          <Field
            label="Params (JSON)"
            htmlFor="pr-params"
            className="span-2"
            hint={paramsErr ? <span className="err-text">{paramsErr}</span> : <>Any chat-completions param: temperature, max_tokens, top_p, reasoning_effort, response_format, stop…</>}
          >
            <textarea id="pr-params" className="textarea mono" rows={7} spellCheck={false} value={params} onChange={(e) => setParams(e.target.value)} />
          </Field>
        </div>
        <CodeBlock
          title="usage"
          lang="py"
          code={`client.chat.completions.create(\n    model="preset/${nm}",\n    messages=[{"role": "user", "content": "..."}],\n)`}
        />
      </form>
    </Modal>
  );
}
