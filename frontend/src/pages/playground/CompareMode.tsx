import { useEffect, useRef, useState } from "react";
import { Columns3, Minus, Play, Plus, Square, X } from "lucide-react";
import type { V1Model } from "../../types";
import { errorMessage } from "../../api";
import { storage } from "../../storage";
import { ModelPicker } from "../../components/ModelPicker";
import { Empty, ErrorBanner, Field } from "../../components/ui";
import { DEFAULT_PARAMS, ParamError, buildBody, runChat, uid, type ChatParams, type MsgMeta } from "./chat";
import { ParamsPanel } from "./ChatMode";
import { AssistantBody, MetaLine } from "./parts";

interface Col {
  id: string;
  model: string;
  content: string;
  reasoning: string;
  toolCalls: { id?: string; function: { name: string; arguments: string } }[];
  meta: MsgMeta | null;
  error: string | null;
  running: boolean;
}

const blank = (model = ""): Col => ({ id: uid(), model, content: "", reasoning: "", toolCalls: [], meta: null, error: null, running: false });

export function CompareMode({ models }: { models: V1Model[] | null }) {
  const [cols, setCols] = useState<Col[]>(() => {
    const saved = storage.getJSON<string[]>("portal.cmp.models", []);
    return (saved.length >= 2 ? saved.slice(0, 4) : ["", ""]).map((m) => blank(m));
  });
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState<ChatParams>({ ...DEFAULT_PARAMS });
  const [err, setErr] = useState<string | null>(null);
  const ctrls = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    storage.setJSON(
      "portal.cmp.models",
      cols.map((c) => c.model),
    );
  }, [cols]);

  // Fill empty slots with sensible defaults once models load.
  useEffect(() => {
    if (!models?.length) return;
    setCols((cs) => {
      if (cs.every((c) => c.model)) return cs;
      const chatAliases = models.filter((m) => m.owned_by === "alias").map((m) => m.id);
      const prefs = ["fast", "balanced", "smart", "cheap", ...chatAliases, ...models.filter((m) => m.kind === "chat").map((m) => m.id)];
      const avail = prefs.filter((p) => models.some((m) => m.id === p));
      const used = new Set(cs.map((c) => c.model).filter(Boolean));
      return cs.map((c) => {
        if (c.model) return c;
        const next = avail.find((a) => !used.has(a));
        if (next) used.add(next);
        return next ? { ...c, model: next } : c;
      });
    });
  }, [models]);

  const update = (id: string, patch: Partial<Col>) => setCols((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const anyRunning = cols.some((c) => c.running);

  const runAll = () => {
    if (!prompt.trim()) {
      setErr("Write a prompt first.");
      return;
    }
    const missing = cols.find((c) => !c.model);
    if (missing) {
      setErr("Pick a model for every column.");
      return;
    }
    setErr(null);
    const msgs = [{ id: "u", role: "user" as const, content: prompt }];
    for (const col of cols) {
      let body: Record<string, unknown>;
      try {
        body = buildBody(col.model, system, msgs, { ...params, response_format: "text", tools_enabled: false, cache: false });
      } catch (e) {
        setErr(e instanceof ParamError ? e.message : errorMessage(e));
        return;
      }
      const ctrl = new AbortController();
      ctrls.current.get(col.id)?.abort();
      ctrls.current.set(col.id, ctrl);
      update(col.id, { content: "", reasoning: "", toolCalls: [], meta: null, error: null, running: true });
      runChat(
        body,
        (s) => update(col.id, { content: s.content, reasoning: s.reasoning, toolCalls: s.toolCalls, meta: s.meta }),
        ctrl.signal,
        false,
      )
        .then((r) => update(col.id, { content: r.content, reasoning: r.reasoning, toolCalls: r.toolCalls, meta: r.meta, running: false }))
        .catch((e) => update(col.id, { running: false, error: ctrl.signal.aborted ? null : errorMessage(e) }))
        .finally(() => ctrls.current.delete(col.id));
    }
  };

  const stopAll = () => ctrls.current.forEach((c) => c.abort());

  // Cheapest / fastest highlights
  const done = cols.filter((c) => c.meta && !c.running && !c.error);
  const cheapest = done.length > 1 ? done.reduce((a, b) => ((a.meta?.usage?.cost ?? Infinity) <= (b.meta?.usage?.cost ?? Infinity) ? a : b)).id : null;
  const fastest = done.length > 1 ? done.reduce((a, b) => ((a.meta?.total ?? Infinity) <= (b.meta?.total ?? Infinity) ? a : b)).id : null;

  return (
    <div className="col gap-12">
      <div className="card">
        <div className="card-body">
          <div className="grid cmp-top">
            <div className="col gap-12" style={{ minWidth: 0 }}>
              <Field label="System prompt (optional)" htmlFor="cmp-system">
                <textarea id="cmp-system" className="textarea" rows={2} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a concise assistant." />
              </Field>
              <Field label="Prompt" htmlFor="cmp-prompt">
                <textarea
                  id="cmp-prompt"
                  className="textarea"
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask the same thing to every model… (Ctrl/⌘+Enter to run)"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      runAll();
                    }
                  }}
                />
              </Field>
              {err && <ErrorBanner error={err} />}
              <div className="row wrap">
                {anyRunning ? (
                  <button className="btn" onClick={stopAll}>
                    <Square /> Stop all
                  </button>
                ) : (
                  <button className="btn primary" onClick={runAll}>
                    <Play /> Run {cols.length} models
                  </button>
                )}
                <span className="spacer" />
                <span className="small muted">Columns</span>
                <button className="btn icon sm" aria-label="Remove column" disabled={cols.length <= 2 || anyRunning} onClick={() => setCols((cs) => cs.slice(0, -1))}>
                  <Minus />
                </button>
                <span className="mono small">{cols.length}</span>
                <button className="btn icon sm" aria-label="Add column" disabled={cols.length >= 4 || anyRunning} onClick={() => setCols((cs) => [...cs, blank()])}>
                  <Plus />
                </button>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <ParamsPanel params={params} setParams={(fn) => setParams(fn)} compact />
            </div>
          </div>
        </div>
      </div>

      <div className="compare-grid" style={{ "--n": cols.length } as React.CSSProperties}>
        {cols.map((c, i) => (
          <div key={c.id} className="card compare-col">
            <div className="card-header" style={{ gap: 6 }}>
              <span className="label">{String.fromCharCode(65 + i)}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <ModelPicker value={c.model} onChange={(m) => update(c.id, { model: m })} models={models} kinds={["chat"]} />
              </div>
              {cols.length > 2 && (
                <button className="btn ghost icon sm" aria-label="Remove column" disabled={c.running} onClick={() => setCols((cs) => cs.filter((x) => x.id !== c.id))}>
                  <X />
                </button>
              )}
            </div>
            <div className="compare-out">
              {c.error && <ErrorBanner error={c.error} />}
              {!c.error && !c.content && !c.reasoning && !c.running && !c.toolCalls.length && <Empty small icon={<Columns3 />} title="Waiting" text="Output streams here." />}
              {(c.content || c.reasoning || c.running || c.toolCalls.length > 0) && (
                <AssistantBody content={c.content} reasoning={c.reasoning} toolCalls={c.toolCalls} streaming={c.running} />
              )}
            </div>
            {c.meta && !c.running && (
              <div className="card-foot" style={{ flexWrap: "wrap" }}>
                <MetaLine meta={c.meta} requested={c.model} />
                {c.id === cheapest && <span className="badge ok">cheapest</span>}
                {c.id === fastest && <span className="badge info">fastest</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
