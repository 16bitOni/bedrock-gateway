import { useMemo, useState } from "react";
import { Calculator, Check, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { api, errorMessage, qs } from "../api";
import type { PriceRow, PricesResponse } from "../types";
import { useAsync } from "../hooks";
import { int, price } from "../format";
import { Empty, ErrorBanner, Field, Modal, SkeletonRows, Spinner } from "../components/ui";
import { useConfirm, useToast } from "../components/feedback";

const COLS: { key: keyof PriceRow; label: string; title: string }[] = [
  { key: "input_per_m", label: "In /1M", title: "USD per 1M input tokens" },
  { key: "output_per_m", label: "Out /1M", title: "USD per 1M output tokens" },
  { key: "cache_read_per_m", label: "Cache rd", title: "USD per 1M cache-read tokens (empty = 10% of input)" },
  { key: "cache_write_per_m", label: "Cache wr", title: "USD per 1M cache-write tokens (empty = 125% of input)" },
  { key: "per_image", label: "/image", title: "USD per generated image" },
  { key: "per_1k_queries", label: "/1k q", title: "USD per 1,000 rerank queries" },
  { key: "per_1m_chars", label: "/1M ch", title: "USD per 1M characters (Polly)" },
  { key: "per_minute", label: "/min", title: "USD per audio minute (Transcribe)" },
];

type EditRow = Record<string, string | boolean>;

function toEdit(r: PriceRow | null): EditRow {
  const e: EditRow = { model_prefix: r?.model_prefix || "", geo_markup: !!r?.geo_markup };
  for (const c of COLS) {
    const v = r ? r[c.key] : null;
    e[c.key] = v === null || v === undefined ? "" : String(v);
  }
  return e;
}

export function PricingTable() {
  const { data, error, loading, reload, setData } = useAsync((signal) => api.get<PricesResponse>("/api/prices", { signal }), []);
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // prefix or "__new__"
  const [draft, setDraft] = useState<EditRow>({});
  const [saving, setSaving] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const [showRecalc, setShowRecalc] = useState(false);
  const [resetting, setResetting] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.data || []).filter((r) => !needle || r.model_prefix.toLowerCase().includes(needle));
  }, [data, q]);

  const startEdit = (r: PriceRow | null) => {
    setEditing(r ? r.model_prefix : "__new__");
    setDraft(toEdit(r));
    setRowErr(null);
  };

  const saveRow = async () => {
    const prefix = String(draft.model_prefix || "").trim();
    if (!prefix) return setRowErr("Model prefix is required.");
    const body: Record<string, unknown> = { model_prefix: prefix, geo_markup: !!draft.geo_markup };
    for (const c of COLS) {
      const v = String(draft[c.key] ?? "").trim();
      if (v !== "" && (isNaN(Number(v)) || Number(v) < 0)) return setRowErr(`${c.label}: must be a non-negative number.`);
      body[c.key] = v === "" ? null : Number(v);
    }
    setSaving(true);
    setRowErr(null);
    try {
      const saved = await api.put<PriceRow>("/api/prices", body);
      setData((d) => {
        if (!d) return d;
        const others = d.data.filter((r) => r.model_prefix !== saved.model_prefix && r.model_prefix !== editing);
        return { ...d, data: [...others, saved].sort((a, b) => a.model_prefix.localeCompare(b.model_prefix)) };
      });
      // Renaming a prefix creates a new row; remove the old one.
      if (editing && editing !== "__new__" && editing !== prefix) await api.del(`/api/prices${qs({ prefix: editing })}`);
      toast.ok(`Saved price for ${prefix}`);
      setEditing(null);
    } catch (e) {
      setRowErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: PriceRow) => {
    const ok = await confirm({ title: `Delete price “${r.model_prefix}”?`, body: "Requests to matching models will fall back to a shorter matching prefix, or cost $0 if none matches.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/prices${qs({ prefix: r.model_prefix })}`);
      setData((d) => (d ? { ...d, data: d.data.filter((x) => x.model_prefix !== r.model_prefix) } : d));
      toast.ok("Price deleted");
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const reset = async () => {
    const ok = await confirm({ title: "Reset default prices?", body: "Restores the built-in price list. Rows you've edited (marked custom) are kept.", confirmLabel: "Reset defaults" });
    if (!ok) return;
    setResetting(true);
    try {
      await api.post("/api/prices/reset");
      toast.ok("Default prices restored");
      await reload();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setResetting(false);
    }
  };

  const editCells = (
    <>
      {COLS.map((c) => (
        <td key={c.key} className="num">
          <input
            className="input price-input"
            aria-label={c.title}
            inputMode="decimal"
            value={String(draft[c.key] ?? "")}
            onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveRow();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        </td>
      ))}
      <td>
        <input type="checkbox" aria-label="Geo markup" checked={!!draft.geo_markup} style={{ accentColor: "var(--accent)" }} onChange={(e) => setDraft((d) => ({ ...d, geo_markup: e.target.checked }))} />
      </td>
      <td />
      <td className="actions">
        <div className="row gap-4" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary icon xs" aria-label="Save row" onClick={saveRow} disabled={saving}>
            {saving ? <Spinner size={11} /> : <Check />}
          </button>
          <button className="btn ghost icon xs" aria-label="Cancel" onClick={() => setEditing(null)}>
            <X />
          </button>
        </div>
      </td>
    </>
  );

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 200 }}>
          <div className="card-title">Pricing</div>
          <div className="card-sub">USD, on-demand. Longest matching prefix of the base model id wins; region prefixes (us., global.) are stripped first.</div>
        </div>
        <button className="btn sm" onClick={() => setShowRecalc(true)}>
          <Calculator /> Recalculate past costs
        </button>
        <button className="btn sm" onClick={reset} disabled={resetting}>
          {resetting ? <Spinner /> : <RotateCcw />} Reset defaults
        </button>
        <button className="btn sm primary" onClick={() => startEdit(null)} disabled={editing === "__new__"}>
          <Plus /> Add row
        </button>
      </div>
      <div className="toolbar">
        <div className="input-group">
          <Search />
          <input className="input" placeholder="Filter prefixes…" aria-label="Filter prices" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="xs muted">
          {data ? (
            <>
              <span className="mono">{rows.length}</span> rows · geo markup ×<span className="mono">{data.geo_profile_markup}</span>
            </>
          ) : null}
        </span>
      </div>
      {error && (
        <div className="card-body">
          <ErrorBanner error={error} onRetry={reload} />
        </div>
      )}
      {rowErr && (
        <div style={{ padding: "10px 14px 0" }}>
          <ErrorBanner error={rowErr} />
        </div>
      )}
      {loading && !data ? (
        <SkeletonRows rows={8} cols={8} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: 560, overflowY: "auto" }}>
          <table className="table compact">
            <thead>
              <tr>
                <th>Model prefix</th>
                {COLS.map((c) => (
                  <th key={c.key} className="num" title={c.title}>
                    {c.label}
                  </th>
                ))}
                <th title="Geo/in-region profiles cost more than global">Geo</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {editing === "__new__" && (
                <tr className="selected">
                  <td>
                    <input
                      className="input sm mono"
                      autoFocus
                      aria-label="Model prefix"
                      placeholder="provider.model-name"
                      style={{ minWidth: 220 }}
                      value={String(draft.model_prefix || "")}
                      onChange={(e) => setDraft((d) => ({ ...d, model_prefix: e.target.value }))}
                    />
                  </td>
                  {editCells}
                </tr>
              )}
              {rows.map((r) =>
                editing === r.model_prefix ? (
                  <tr key={r.model_prefix} className="selected">
                    <td>
                      <input className="input sm mono" aria-label="Model prefix" style={{ minWidth: 220 }} value={String(draft.model_prefix || "")} onChange={(e) => setDraft((d) => ({ ...d, model_prefix: e.target.value }))} />
                    </td>
                    {editCells}
                  </tr>
                ) : (
                  <tr key={r.model_prefix} onDoubleClick={() => startEdit(r)}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {r.model_prefix}
                    </td>
                    {COLS.map((c) => {
                      const v = r[c.key] as number | null;
                      const zeroish = v === null || (v === 0 && (c.key === "input_per_m" || c.key === "output_per_m") && (r.per_image || r.per_1k_queries || r.per_1m_chars || r.per_minute));
                      return (
                        <td key={c.key} className="num">
                          {zeroish ? <span className="faint">—</span> : price(v)}
                        </td>
                      );
                    })}
                    <td>{r.geo_markup ? <span className="badge info">geo</span> : null}</td>
                    <td>{r.custom ? <span className="badge accent" title="Edited — survives Reset defaults">custom</span> : null}</td>
                    <td className="actions">
                      <div className="row gap-4" style={{ justifyContent: "flex-end" }}>
                        <button className="btn ghost icon xs" aria-label={`Edit ${r.model_prefix}`} onClick={() => startEdit(r)} disabled={!!editing}>
                          <Pencil />
                        </button>
                        <button className="btn ghost icon xs" aria-label={`Delete ${r.model_prefix}`} onClick={() => remove(r)} disabled={!!editing}>
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {rows.length === 0 && editing !== "__new__" && <Empty small title="No prices match" text="Add a row for any model prefix, e.g. anthropic.claude-sonnet-5-5." />}
        </div>
      )}
      {showRecalc && <RecalcDialog onClose={() => setShowRecalc(false)} />}
    </div>
  );
}

function RecalcDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState("31");
  const [busy, setBusy] = useState(false);
  const n = Number(days);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ updated: number }>("/api/prices/recalculate", { days: n });
      toast.ok(`Re-priced ${int(r.updated)} requests`);
      onClose();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Recalculate past costs"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={busy || !(n > 0)}>
            {busy && <Spinner />} Recalculate
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="small text-2">Re-prices successful logged requests with the current price table — useful after correcting a price. Cached responses stay at $0.</p>
        <Field label="Look back (days)" htmlFor="rc-days">
          <input id="rc-days" className="input mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
