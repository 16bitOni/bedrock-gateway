import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Code2, Eraser, ImagePlus, MessageSquare, RotateCcw, Send, Square, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../api";
import type { LogDetail, V1Model } from "../../types";
import { bytes } from "../../format";
import { storage } from "../../storage";
import { ModelPicker } from "../../components/ModelPicker";
import { Banner, CodeBlock, CopyButton, Empty, ErrorBanner, Field, Modal, Seg, Spinner, Switch, Tabs } from "../../components/ui";
import { useToast } from "../../components/feedback";
import {
  DEFAULT_PARAMS,
  ParamError,
  buildBody,
  codegen,
  replayFromBody,
  runChat,
  uid,
  type ChatMsg,
  type ChatParams,
  type Effort,
  type RespFormat,
} from "./chat";
import { AssistantBody, MetaLine, ToolResultCard } from "./parts";

const CHAT_KINDS = ["chat"];
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error(`${file.name} is not an image.`));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`${file.name} is ${bytes(file.size)} — Bedrock accepts images up to 3.75 MB.`));
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

export function ParamsPanel({
  params,
  setParams,
  compact,
}: {
  params: ChatParams;
  setParams: (fn: (p: ChatParams) => ChatParams) => void;
  compact?: boolean;
}) {
  const set = <K extends keyof ChatParams>(k: K, v: ChatParams[K]) => setParams((p) => ({ ...p, [k]: v }));
  return (
    <div className="col gap-12">
      <Field
        label="Temperature"
        right={
          <label className="check xs">
            <input type="checkbox" checked={params.temperature === null} onChange={(e) => set("temperature", e.target.checked ? null : 0.7)} />
            default
          </label>
        }
      >
        <div className="row">
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            aria-label="Temperature"
            disabled={params.temperature === null}
            value={params.temperature ?? 1}
            onChange={(e) => set("temperature", Number(e.target.value))}
          />
          <span className="mono small" style={{ width: 34, textAlign: "right" }}>
            {params.temperature === null ? "—" : params.temperature.toFixed(2)}
          </span>
        </div>
      </Field>
      <Field label="Max tokens" htmlFor="p-max" hint={compact ? undefined : "Empty = gateway default (Settings → Gateway)."}>
        <input
          id="p-max"
          className="input mono"
          type="number"
          min={1}
          placeholder="default"
          value={params.max_tokens ?? ""}
          onChange={(e) => set("max_tokens", e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null)}
        />
      </Field>
      <Field label="Reasoning effort" hint={compact ? undefined : "Mapped to extended thinking / reasoning config per model."}>
        <Seg<Effort>
          value={params.reasoning_effort}
          onChange={(v) => set("reasoning_effort", v)}
          options={[
            { value: "none", label: "none" },
            { value: "low", label: "low" },
            { value: "medium", label: "med" },
            { value: "high", label: "high" },
          ]}
        />
      </Field>
      {!compact && (
        <>
          <Field label="Response format" htmlFor="p-rf">
            <select id="p-rf" className="select" value={params.response_format} onChange={(e) => set("response_format", e.target.value as RespFormat)}>
              <option value="text">text</option>
              <option value="json_object">json_object</option>
              <option value="json_schema">json_schema</option>
            </select>
          </Field>
          {params.response_format === "json_schema" && (
            <Field label="JSON schema" htmlFor="p-schema" hint={<>Either a full <code>{"{name, strict, schema}"}</code> object or a bare JSON Schema.</>}>
              <textarea id="p-schema" className="textarea mono" rows={9} spellCheck={false} value={params.json_schema} onChange={(e) => set("json_schema", e.target.value)} />
            </Field>
          )}
          <div className="row">
            <span className="field-label grow">Tools</span>
            <Switch checked={params.tools_enabled} onChange={(v) => set("tools_enabled", v)} label="Enable tools" />
          </div>
          {params.tools_enabled && (
            <textarea className="textarea mono" aria-label="Tools JSON" rows={10} spellCheck={false} value={params.tools} onChange={(e) => set("tools", e.target.value)} />
          )}
          <div className="row">
            <span className="field-label grow" title="Sends x-portal-cache: 1. The exact-match cache only works for non-streaming calls, so the request is sent without streaming.">
              Response cache <span className="faint xs">(non-streaming)</span>
            </span>
            <Switch checked={params.cache} onChange={(v) => set("cache", v)} label="Response cache" />
          </div>
        </>
      )}
    </div>
  );
}

export function CodeModal({ body, baseUrl, cache, onClose }: { body: Record<string, unknown>; baseUrl: string; cache: boolean; onClose: () => void }) {
  const [lang, setLang] = useState<"python" | "curl" | "js">(() => (storage.get("portal.codegen.lang") as "python") || "python");
  const [stream, setStream] = useState(true);
  const code = codegen(lang, baseUrl, body, stream, cache);
  return (
    <Modal title="Copy as code" size="lg" onClose={onClose} footer={<CopyButton text={code} label="Copy code" size="sm" ghost={false} />}>
      <div className="col gap-12">
        <div className="row wrap">
          <Tabs
            value={lang}
            onChange={(v) => {
              setLang(v);
              storage.set("portal.codegen.lang", v);
            }}
            tabs={[
              { value: "python", label: "Python" },
              { value: "curl", label: "curl" },
              { value: "js", label: "Node.js" },
            ]}
          />
          <span className="spacer" />
          <label className="check small">
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> stream
          </label>
        </div>
        <CodeBlock code={code} lang={lang === "js" ? "js" : "py"} maxHeight={460} />
        <div className="xs muted">
          Set <code className="mono">PORTAL_API_KEY</code> to a key from the API Keys page. Attached images are elided from the snippet.
        </div>
      </div>
    </Modal>
  );
}

function ToolResponder({ calls, onSubmit, disabled }: { calls: { id?: string; function: { name: string } }[]; onSubmit: (results: { id: string; name: string; content: string }[]) => void; disabled: boolean }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  return (
    <div className="card card-pad col gap-8" style={{ background: "var(--surface-2)" }}>
      <div className="label">Respond to tool calls</div>
      {calls.map((c, i) => {
        const key = c.id || String(i);
        return (
          <Field key={key} label={<span className="mono">{c.function.name}</span>} htmlFor={`tr-${key}`}>
            <textarea
              id={`tr-${key}`}
              className="textarea mono"
              rows={2}
              placeholder='{"temperature": 21, "unit": "c"}'
              value={vals[key] || ""}
              onChange={(e) => setVals((v) => ({ ...v, [key]: e.target.value }))}
            />
          </Field>
        );
      })}
      <div className="row">
        <span className="spacer" />
        <button
          className="btn sm primary"
          disabled={disabled}
          onClick={() => onSubmit(calls.map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, content: vals[c.id || String(i)] || "" })))}
        >
          <Send /> Send results
        </button>
      </div>
    </div>
  );
}

export function ChatMode({ models, baseUrl }: { models: V1Model[] | null; baseUrl: string }) {
  const toast = useToast();
  const [search, setSearch] = useSearchParams();
  const [model, setModel] = useState(() => storage.get("portal.pg.model") || "");
  const [system, setSystem] = useState(() => storage.get("portal.pg.system") || "");
  const [params, setParamsState] = useState<ChatParams>(() => ({ ...DEFAULT_PARAMS, ...storage.getJSON<Partial<ChatParams>>("portal.pg.params", {}) }));
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [replayInfo, setReplayInfo] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const setParams = (fn: (p: ChatParams) => ChatParams) =>
    setParamsState((p) => {
      const n = fn(p);
      storage.setJSON("portal.pg.params", n);
      return n;
    });

  useEffect(() => storage.set("portal.pg.model", model), [model]);
  useEffect(() => storage.set("portal.pg.system", system), [system]);

  // Default model: first chat alias, else first chat model.
  useEffect(() => {
    if (model || !models?.length) return;
    const pick = models.find((m) => m.id === "smart") || models.find((m) => m.owned_by === "alias") || models.find((m) => m.kind === "chat");
    if (pick) setModel(pick.id);
  }, [models, model]);

  // ?replay=<log id>
  const replayId = search.get("replay");
  useEffect(() => {
    if (!replayId) return;
    let alive = true;
    setReplayLoading(true);
    api
      .get<LogDetail>(`/api/logs/${encodeURIComponent(replayId)}`)
      .then((log) => {
        if (!alive) return;
        const st = replayFromBody(log.endpoint, log.request_body);
        if (!st || (!st.messages.length && !st.system)) {
          setErr(log.request_body ? "This log's request body can't be replayed in chat mode." : "This request was logged without a body (body logging is off for this key or globally).");
          return;
        }
        setModel(st.model || log.requested_model || "");
        setSystem(st.system);
        setParams(() => ({ ...DEFAULT_PARAMS, ...st.params }));
        setMessages(st.messages);
        setReplayInfo(log.id);
        setErr(null);
      })
      .catch((e) => alive && setErr(errorMessage(e)))
      .finally(() => {
        if (alive) setReplayLoading(false);
        const next = new URLSearchParams(search);
        next.delete("replay");
        setSearch(next, { replace: true });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayId]);

  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickBottom.current) return;
    const page = document.scrollingElement || document.documentElement;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) page.scrollTop += rect.bottom - window.innerHeight + 140;
  }, [messages]);

  const last = messages[messages.length - 1];
  const canRun = !running && !!model && (input.trim() !== "" || images.length > 0 || last?.role === "user" || last?.role === "tool");

  const currentBody = useMemo(() => {
    const draft: ChatMsg[] = input.trim() || images.length ? [{ id: "draft", role: "user", content: input, images }] : [];
    try {
      return buildBody(model || "smart", system, [...messages.filter((m) => !m.streaming), ...draft], params);
    } catch {
      return buildBody(model || "smart", system, [...messages.filter((m) => !m.streaming), ...draft], { ...params, response_format: "text", tools_enabled: false });
    }
  }, [model, system, messages, input, images, params]);

  const run = async (base: ChatMsg[]) => {
    let body: Record<string, unknown>;
    try {
      body = buildBody(model, system, base, params);
    } catch (e) {
      setErr(e instanceof ParamError ? e.message : errorMessage(e));
      return;
    }
    setErr(null);
    const aid = uid();
    stickBottom.current = true;
    setMessages([...base, { id: aid, role: "assistant", content: "", streaming: true }]);
    const c = new AbortController();
    ctrl.current = c;
    setRunning(true);
    const update = (patch: Partial<ChatMsg>) => setMessages((ms) => ms.map((m) => (m.id === aid ? { ...m, ...patch } : m)));
    let partial: Partial<ChatMsg> = {};
    try {
      const r = await runChat(
        body,
        (s) => {
          partial = { content: s.content, reasoning: s.reasoning || undefined, toolCalls: s.toolCalls.length ? s.toolCalls : undefined, meta: s.meta };
          update(partial);
        },
        c.signal,
        params.cache,
      );
      update({ content: r.content, reasoning: r.reasoning || undefined, toolCalls: r.toolCalls.length ? r.toolCalls : undefined, meta: r.meta, streaming: false });
    } catch (e) {
      if (c.signal.aborted) {
        update({ ...partial, streaming: false, meta: partial.meta ? { ...partial.meta, finish: "stopped" } : undefined });
      } else {
        update({ ...partial, streaming: false, error: errorMessage(e) });
      }
    } finally {
      setRunning(false);
      ctrl.current = null;
    }
  };

  const send = () => {
    if (!canRun) {
      if (!model) setErr("Pick a model first.");
      return;
    }
    let base = messages.filter((m) => !(m.role === "assistant" && m.error && !m.content && !m.toolCalls?.length));
    if (input.trim() || images.length) {
      base = [...base, { id: uid(), role: "user", content: input, images: images.length ? images : undefined }];
      setInput("");
      setImages([]);
    }
    void run(base);
  };

  const retry = (id: string) => {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    void run(messages.slice(0, idx));
  };

  const addImages = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        const url = await readImageFile(f);
        setImages((im) => [...im, url]);
      } catch (e) {
        toast.err(errorMessage(e));
      }
    }
  };

  const lastToolCalls = last?.role === "assistant" && !last.streaming && last.toolCalls?.length ? last.toolCalls : null;

  return (
    <div className="pg">
      <div className="card" style={{ minWidth: 0 }}>
        <div className="card-header">
          <MessageSquare size={14} className="muted" />
          <div className="card-title grow">Conversation</div>
          <button className="btn ghost xs" onClick={() => setShowCode(true)} disabled={!model}>
            <Code2 /> Copy as code
          </button>
          <button
            className="btn ghost xs"
            onClick={() => {
              ctrl.current?.abort();
              setMessages([]);
              setErr(null);
              setReplayInfo(null);
            }}
            disabled={!messages.length}
          >
            <Eraser /> Clear
          </button>
        </div>
        <div className="chat-log" ref={logRef}>
          {replayLoading && (
            <div className="row muted small">
              <Spinner /> Loading request for replay…
            </div>
          )}
          {replayInfo && (
            <Banner kind="info" onClose={() => setReplayInfo(null)}>
              Replaying <code className="mono">{replayInfo}</code>. Press <b>Run</b> to send it again, or edit first.
            </Banner>
          )}
          {models !== null && !models.some((m) => m.kind === "chat" || m.owned_by === "alias" || m.owned_by === "preset") && (
            <Banner kind="accent" title="No chat models enabled yet">
              Connect AWS and sync the catalog on the <Link className="link" to="/models">Models</Link> page — or type any Bedrock model id into the model picker.
            </Banner>
          )}
          {!messages.length && !replayLoading && (
            <Empty
              icon={<MessageSquare />}
              title="Start a conversation"
              text={
                <>
                  Requests go through the gateway as the built-in <b>Playground</b> key and are logged like any other call. Use{" "}
                  <kbd className="mono">Enter</kbd> to send, <kbd className="mono">Shift+Enter</kbd> for a new line, paste images to attach them.
                </>
              }
            />
          )}
          {messages.map((m, i) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msg-head">
                <span className="msg-role">{m.role === "tool" ? "tool" : m.role}</span>
                {m.streaming && <Spinner size={11} />}
                <span className="msg-actions">
                  {m.role === "assistant" && !m.streaming && i === messages.length - 1 && (
                    <button className="btn ghost icon xs" title="Regenerate" aria-label="Regenerate" onClick={() => retry(m.id)} disabled={running}>
                      <RotateCcw />
                    </button>
                  )}
                  {m.content && <CopyButton text={m.content} />}
                  <button
                    className="btn ghost icon xs"
                    title="Delete message"
                    aria-label="Delete message"
                    disabled={running}
                    onClick={() => setMessages((ms) => ms.filter((x) => x.id !== m.id))}
                  >
                    <Trash2 />
                  </button>
                </span>
              </div>
              {m.role === "user" && (
                <>
                  {m.images?.length ? (
                    <div className="msg-images">
                      {m.images.map((src, j) => (
                        <img key={j} src={src} alt={`attachment ${j + 1}`} />
                      ))}
                    </div>
                  ) : null}
                  {m.content && <div className="msg-body">{m.content}</div>}
                </>
              )}
              {m.role === "tool" && <ToolResultCard id={m.toolCallId} content={m.content} name={m.toolName} />}
              {m.role === "assistant" && (
                <div className="msg-body">
                  <AssistantBody content={m.content} reasoning={m.reasoning} toolCalls={m.toolCalls} streaming={m.streaming} />
                </div>
              )}
              {m.error && <ErrorBanner error={m.error} />}
              {m.meta && !m.streaming && <MetaLine meta={m.meta} requested={model} />}
            </div>
          ))}
          {lastToolCalls && (
            <ToolResponder
              calls={lastToolCalls}
              disabled={running}
              onSubmit={(results) => {
                const base = [...messages, ...results.map((r) => ({ id: uid(), role: "tool" as const, content: r.content || "{}", toolCallId: r.id, toolName: r.name }))];
                void run(base);
              }}
            />
          )}
        </div>
        <div className="composer">
          {err && <ErrorBanner error={err} />}
          {images.length > 0 && (
            <div className="attach-thumbs">
              {images.map((src, i) => (
                <div className="attach-thumb" key={i}>
                  <img src={src} alt={`attachment ${i + 1}`} />
                  <button aria-label="Remove image" onClick={() => setImages((im) => im.filter((_, j) => j !== i))}>
                    <X />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="textarea"
            aria-label="Message"
            placeholder={last?.role === "user" || last?.role === "tool" ? "Press Run to continue, or add another message…" : "Message… (Enter to send)"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            rows={3}
          />
          <div className="row">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => e.target.files && addImages(e.target.files).then(() => (e.target.value = ""))} />
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()} title="Attach images">
              <ImagePlus /> Image
            </button>
            <span className="spacer" />
            <span className="xs faint mono" style={{ display: model ? undefined : "none" }}>
              {model}
            </span>
            {running ? (
              <button className="btn sm" onClick={() => ctrl.current?.abort()}>
                <Square /> Stop
              </button>
            ) : (
              <button className="btn primary sm" onClick={send} disabled={!canRun}>
                <Send /> {input.trim() || images.length ? "Send" : "Run"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card pg-side last-sm">
        <div className="card-body col gap-12">
          <Field label="Model" htmlFor="pg-model">
            <ModelPicker id="pg-model" value={model} onChange={setModel} models={models} kinds={CHAT_KINDS} align="right" />
          </Field>
          <Field label="System prompt" htmlFor="pg-system">
            <textarea id="pg-system" className="textarea" rows={4} placeholder="You are a helpful assistant." value={system} onChange={(e) => setSystem(e.target.value)} />
          </Field>
          <hr className="divider" style={{ margin: "2px 0" }} />
          <ParamsPanel params={params} setParams={setParams} />
          <button className="btn ghost xs" style={{ alignSelf: "flex-start" }} onClick={() => setParams(() => ({ ...DEFAULT_PARAMS }))}>
            <RotateCcw /> Reset parameters
          </button>
        </div>
      </div>
      {showCode && <CodeModal body={currentBody} baseUrl={baseUrl} cache={params.cache} onClose={() => setShowCode(false)} />}
    </div>
  );
}
