// Searchable model combobox fed by GET /v1/models (aliases → presets → models by kind).
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, CornerDownLeft, Search } from "lucide-react";
import { api, errorMessage } from "../api";
import type { V1Model } from "../types";
import { useClickOutside } from "../hooks";

let cache: Promise<V1Model[]> | null = null;
const listeners = new Set<() => void>();

export function loadV1Models(force = false): Promise<V1Model[]> {
  if (!cache || force) {
    cache = api.get<{ data: V1Model[] }>("/v1/models").then((r) => r.data);
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}

/** Call after models/aliases/presets change so pickers refetch. */
export function invalidateV1Models(): void {
  cache = null;
  listeners.forEach((l) => l());
}

export function useV1Models(): { models: V1Model[] | null; error: string | null; reload: () => void } {
  const [models, setModels] = useState<V1Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    loadV1Models()
      .then((m) => {
        if (alive) {
          setModels(m);
          setError(null);
        }
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [tick]);
  return { models, error, reload: () => invalidateV1Models() };
}

/** Kind of a /v1/models entry; aliases & presets inherit their first target's kind. */
export function modelKind(m: V1Model, all: V1Model[]): string | undefined {
  if (m.kind) return m.kind;
  const byId = new Map(all.filter((x) => x.kind).map((x) => [x.id, x.kind as string]));
  for (const t of m.targets || []) {
    const k = byId.get(t);
    if (k) return k;
    // preset → alias → model
    const alias = all.find((x) => x.id === t && x.owned_by === "alias");
    if (alias) {
      for (const t2 of alias.targets || []) {
        const k2 = byId.get(t2);
        if (k2) return k2;
      }
    }
  }
  return undefined;
}

const KIND_LABEL: Record<string, string> = {
  chat: "Chat models",
  embedding: "Embedding models",
  image: "Image models",
  rerank: "Rerank models",
  speech: "Speech",
  transcription: "Transcription",
  realtime: "Realtime / speech-to-speech",
  video: "Video",
  other: "Other",
};

interface Group {
  label: string;
  items: { id: string; sub?: string }[];
}

export function ModelPicker({
  value,
  onChange,
  models,
  kinds,
  placeholder = "Select a model…",
  allowCustom = true,
  id,
  align,
  extra,
}: {
  value: string;
  onChange: (id: string) => void;
  models: V1Model[] | null;
  /** Only show models of these kinds (aliases/presets are matched by their target's kind; unknown kinds are kept). */
  kinds?: string[];
  placeholder?: string;
  allowCustom?: boolean;
  id?: string;
  align?: "right";
  /** Extra options shown first (e.g. virtual ids not in /v1/models). */
  extra?: { id: string; sub?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const groups = useMemo<Group[]>(() => {
    const all = models || [];
    const ok = (m: V1Model) => {
      if (!kinds) return true;
      const k = modelKind(m, all);
      if (k === undefined) return m.owned_by === "alias" || m.owned_by === "preset";
      return kinds.includes(k);
    };
    const needle = q.trim().toLowerCase();
    const match = (s: string, sub?: string) => !needle || s.toLowerCase().includes(needle) || (sub || "").toLowerCase().includes(needle);
    const out: Group[] = [];
    if (extra?.length) {
      const items = extra.filter((e) => match(e.id, e.sub));
      if (items.length) out.push({ label: "Suggested", items });
    }
    const aliases = all.filter((m) => m.owned_by === "alias" && ok(m)).map((m) => ({ id: m.id, sub: (m.targets || [])[0] }));
    const presets = all.filter((m) => m.owned_by === "preset" && ok(m)).map((m) => ({ id: m.id, sub: (m.targets || [])[0] }));
    const a = aliases.filter((x) => match(x.id, x.sub));
    const p = presets.filter((x) => match(x.id, x.sub));
    if (a.length) out.push({ label: "Aliases", items: a });
    if (p.length) out.push({ label: "Presets", items: p });
    const byKind = new Map<string, { id: string; sub?: string }[]>();
    for (const m of all) {
      if (m.owned_by === "alias" || m.owned_by === "preset" || !ok(m)) continue;
      if (!match(m.id, m.owned_by)) continue;
      const k = m.kind || "other";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k)!.push({ id: m.id, sub: m.owned_by });
    }
    const order = ["chat", "embedding", "image", "rerank", "speech", "transcription", "realtime", "video", "other"];
    for (const k of [...byKind.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y))) {
      out.push({ label: KIND_LABEL[k] || k, items: byKind.get(k)! });
    }
    return out;
  }, [models, kinds, q, extra]);

  const flat = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);
  const customAllowed = allowCustom && q.trim() && !flat.includes(q.trim());
  const options = customAllowed ? [...flat, q.trim()] : flat;

  useEffect(() => {
    setActive(0);
  }, [q, open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };

  let idx = -1;
  return (
    <div className="combo" ref={ref}>
      <button
        type="button"
        id={id}
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? <span className="grow truncate">{value}</span> : <span className="grow truncate placeholder">{placeholder}</span>}
        <ChevronsUpDown />
      </button>
      {open && (
        <div className={`combo-pop ${align === "right" ? "right" : ""}`}>
          <div className="combo-search">
            <Search />
            <input
              autoFocus
              placeholder={allowCustom ? "Search or type any model id…" : "Search…"}
              value={q}
              aria-label="Search models"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(options.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (options[active]) pick(options[active]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
          </div>
          <div className="combo-list" role="listbox" ref={listRef}>
            {models === null && <div className="combo-empty">Loading models…</div>}
            {models !== null && options.length === 0 && (
              <div className="combo-empty">
                {models.length === 0 ? "No models enabled yet. Sync models from AWS on the Models page." : "No matches."}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="combo-group label">{g.label}</div>
                {g.items.map((it) => {
                  idx++;
                  const i = idx;
                  return (
                    <button
                      key={g.label + it.id}
                      type="button"
                      role="option"
                      aria-selected={it.id === value}
                      data-idx={i}
                      className={`combo-opt ${i === active ? "active" : ""} ${it.id === value ? "selected" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(it.id)}
                    >
                      <span className="opt-main">{it.id}</span>
                      {it.sub && <span className="opt-sub">{it.sub}</span>}
                      {it.id === value && <Check />}
                    </button>
                  );
                })}
              </div>
            ))}
            {customAllowed && (
              <button
                type="button"
                data-idx={options.length - 1}
                className={`combo-opt ${active === options.length - 1 ? "active" : ""}`}
                onMouseEnter={() => setActive(options.length - 1)}
                onClick={() => pick(q.trim())}
              >
                <CornerDownLeft />
                <span className="opt-main">Use “{q.trim()}”</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
