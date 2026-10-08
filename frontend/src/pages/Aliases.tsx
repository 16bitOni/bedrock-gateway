import { useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, GitBranch, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../api";
import type { Alias, CatalogModel, ModelsResponse, V1Model } from "../types";
import { useAsync } from "../hooks";
import { CopyButton, Empty, ErrorBanner, Field, Modal, SkeletonRows, Spinner } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";
import { ModelPicker, invalidateV1Models } from "../components/ModelPicker";

function toPickerModels(rows: CatalogModel[]): V1Model[] {
  return rows.map((r) => ({ id: r.id, object: "model", created: r.updated_at, owned_by: r.provider.toLowerCase() + (r.enabled ? "" : " · disabled"), kind: r.kind }));
}

export function AliasesTab() {
  const aliases = useAsync((signal) => api.get<{ data: Alias[] }>("/api/aliases", { signal }), []);
  const models = useAsync((signal) => api.get<ModelsResponse>("/api/models", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Alias | "new" | null>(null);
  const [resetting, setResetting] = useState(false);

  const byId = useMemo(() => new Map((models.data?.data || []).map((m) => [m.id, m])), [models.data]);

  const remove = async (a: Alias) => {
    const ok = await confirm({
      title: `Delete alias “${a.name}”?`,
      body: "Clients calling this name will get model_not_found. Default aliases can be recreated with “Reset default aliases”.",
      confirmLabel: "Delete alias",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/aliases/${encodeURIComponent(a.name)}`);
      toast.ok(`Deleted ${a.name}`);
      invalidateV1Models();
      void aliases.reload();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const reset = async () => {
    const ok = await confirm({
      title: "Reset default aliases?",
      body: "Re-points every built-in alias (smart, fast, embed, gpt-4o, …) at the newest matching model in your catalog. Your custom aliases are kept; edits to built-in names are overwritten.",
      confirmLabel: "Reset defaults",
    });
    if (!ok) return;
    setResetting(true);
    try {
      const r = await api.post<{ created: number }>("/api/aliases/reset-defaults");
      toast.ok(r.created ? `Reset ${r.created} default aliases` : "No matching models — sync the catalog first");
      invalidateV1Models();
      void aliases.reload();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setResetting(false);
    }
  };

  const list = aliases.data?.data || [];
  return (
    <div className="col gap-12">
      <ErrorBanner error={aliases.error} onRetry={aliases.reload} />
      <div className="card">
        <div className="card-header">
          <GitBranch size={14} className="muted" />
          <div className="grow">
            <div className="card-title">Aliases</div>
            <div className="card-sub">Stable names with an ordered fallback chain. If the primary is throttled, unavailable or out of context, the next target is tried.</div>
          </div>
          <button className="btn sm" onClick={reset} disabled={resetting}>
            {resetting ? <Spinner /> : <RotateCcw />} Reset defaults
          </button>
          <button className="btn sm primary" onClick={() => setEditing("new")}>
            <Plus /> New alias
          </button>
        </div>
        {aliases.loading && !aliases.data ? (
          <SkeletonRows rows={8} cols={3} />
        ) : list.length === 0 ? (
          <Empty
            icon={<GitBranch />}
            title="No aliases yet"
            text="Default aliases (smart, fast, cheap, embed, image, gpt-4o, …) are created automatically on the first model sync."
            action={
              <button className="btn sm" onClick={reset} disabled={resetting}>
                Create default aliases
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Fallback chain</th>
                  <th>Description</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.name}>
                    <td>
                      <span className="row gap-4">
                        <span className="mono" style={{ fontWeight: 600 }}>
                          {a.name}
                        </span>
                        <CopyButton text={a.name} />
                      </span>
                    </td>
                    <td className="wrap" style={{ minWidth: 260 }}>
                      <div className="chain">
                        {a.targets.map((t, i) => {
                          const m = byId.get(t);
                          return (
                            <span key={t} className="row gap-4">
                              {i > 0 && <ArrowRight />}
                              <span className="chip" title={m ? `${m.name}${m.enabled ? "" : " (disabled)"}` : "Not in catalog — Bedrock will validate it"} style={i === 0 ? { borderColor: "var(--accent-line)", color: "var(--text)" } : undefined}>
                                {t}
                                {m && !m.enabled && <span className="warn-text">·off</span>}
                                {!m && models.data && <span className="faint">·?</span>}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="wrap muted" style={{ minWidth: 180 }}>
                      {a.description || "—"}
                    </td>
                    <td className="actions">
                      <div className="row gap-4" style={{ justifyContent: "flex-end" }}>
                        <button className="btn ghost icon sm" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                          <Pencil />
                        </button>
                        <button className="btn ghost icon sm" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}>
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
        <AliasEditor
          alias={editing === "new" ? null : editing}
          models={models.data?.data || null}
          existing={list.map((a) => a.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateV1Models();
            void aliases.reload();
          }}
        />
      )}
    </div>
  );
}

function AliasEditor({ alias, models, existing, onClose, onSaved }: { alias: Alias | null; models: CatalogModel[] | null; existing: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(alias?.name || "");
  const [description, setDescription] = useState(alias?.description || "");
  const [targets, setTargets] = useState<string[]>(alias?.targets || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const picker = useMemo(() => (models ? toPickerModels(models) : null), [models]);
  const byId = useMemo(() => new Map((models || []).map((m) => [m.id, m])), [models]);

  const move = (i: number, d: -1 | 1) =>
    setTargets((t) => {
      const n = [...t];
      const j = i + d;
      if (j < 0 || j >= n.length) return t;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm) return setErr("Name is required.");
    if (/\s/.test(nm) || (nm.includes("/") && !nm.startsWith("polly/"))) return setErr("Alias names can't contain spaces or '/'.");
    if (!alias && existing.includes(nm)) return setErr(`An alias named “${nm}” already exists — edit it instead.`);
    if (!targets.length) return setErr("Add at least one target model.");
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/aliases/${encodeURIComponent(nm)}`, { targets, description: description.trim() || null });
      toast.ok(`Saved alias ${nm}`);
      onSaved();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={alias ? `Edit alias “${alias.name}”` : "New alias"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="alias-form" disabled={busy}>
            {busy && <Spinner />} Save alias
          </button>
        </>
      }
    >
      <form id="alias-form" className="col gap-12" onSubmit={save}>
        {err && <ErrorBanner error={err} />}
        <div className="form-grid">
          <Field label="Name" htmlFor="al-name" hint="What clients send as `model`.">
            <input id="al-name" className="input mono" autoFocus={!alias} disabled={!!alias} value={name} placeholder="my-model" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="al-desc">
            <input id="al-desc" className="input" value={description} placeholder="optional" onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label="Targets — first is primary, the rest are fallbacks in order">
          {targets.length > 0 ? (
            <div className="reorder-list">
              {targets.map((t, i) => {
                const m = byId.get(t);
                return (
                  <div key={t} className="reorder-item">
                    <span className="idx">{i + 1}</span>
                    <span className="grow truncate" title={t}>
                      {t}
                      {m && !m.enabled && <span className="warn-text xs"> (disabled)</span>}
                      {i === 0 && <span className="badge accent" style={{ marginLeft: 6 }}>primary</span>}
                    </span>
                    <button type="button" className="btn ghost icon xs" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </button>
                    <button type="button" className="btn ghost icon xs" aria-label="Move down" disabled={i === targets.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown />
                    </button>
                    <button type="button" className="btn ghost icon xs" aria-label="Remove" onClick={() => setTargets((ts) => ts.filter((x) => x !== t))}>
                      <X />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="xs muted">No targets yet.</div>
          )}
        </Field>
        <Field label="Add target" hint="Pick from the catalog (disabled models still work as alias targets) or type any Bedrock id / ARN.">
          <ModelPicker value="" placeholder="Add a model…" models={picker} onChange={(id) => id && !targets.includes(id) && setTargets((t) => [...t, id])} />
        </Field>
      </form>
    </Modal>
  );
}
