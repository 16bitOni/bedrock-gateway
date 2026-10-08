import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AudioLines, Download, ExternalLink, FileAudio, ImageIcon, Mic, Play, Square, Trash2, Upload, Wand2 } from "lucide-react";
import { api, errorMessage, rawFetch } from "../../api";
import type { ImageResult, PricesResponse, TranscriptionResult, V1Model, Voice, VoicesResponse } from "../../types";
import { bytes, duration, int, money } from "../../format";
import { storage } from "../../storage";
import { ModelPicker } from "../../components/ModelPicker";
import { Banner, CopyButton, Empty, ErrorBanner, Field, Seg, Spinner } from "../../components/ui";
import { useToast } from "../../components/feedback";

// ============================================================== Images

interface Generation {
  id: string;
  prompt: string;
  model: string | null;
  requested: string;
  size: string;
  cost: number | null;
  urls: string[];
  ms: number;
  requestId: string | null;
}

const SIZES = ["1024x1024", "1280x720", "720x1280", "1152x896", "896x1152", "1536x640", "512x512", "2048x2048"];

export function ImageMode({ models }: { models: V1Model[] | null }) {
  const [model, setModel] = useState(() => storage.get("portal.img.model") || "image");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState<"standard" | "premium">("standard");
  const [n, setN] = useState(1);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gens, setGens] = useState<Generation[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => storage.set("portal.img.model", model), [model]);

  const generate = async () => {
    if (!prompt.trim()) {
      setErr("Describe the image you want.");
      return;
    }
    setBusy(true);
    setErr(null);
    const c = new AbortController();
    ctrl.current = c;
    const t0 = performance.now();
    try {
      const body: Record<string, unknown> = { model: model || "image", prompt, size, quality, n, response_format: "url" };
      if (negative.trim()) body.negative_prompt = negative;
      if (seed.trim()) body.seed = parseInt(seed, 10);
      const res = await rawFetch("POST", "/v1/images/generations", body, { signal: c.signal });
      const j = (await res.json()) as ImageResult;
      setGens((g) => [
        {
          id: res.headers.get("x-request-id") || String(Date.now()),
          prompt,
          model: res.headers.get("x-portal-model"),
          requested: model,
          size,
          cost: j.usage?.cost ?? null,
          urls: j.data.map((d) => d.url || (d.b64_json ? `data:image/png;base64,${d.b64_json}` : "")).filter(Boolean),
          ms: performance.now() - t0,
          requestId: res.headers.get("x-request-id"),
        },
        ...g,
      ]);
    } catch (e) {
      if (!c.signal.aborted) setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pg">
      <div className="col gap-12" style={{ minWidth: 0 }}>
        {err && <ErrorBanner error={err} />}
        {busy && (
          <div className="card card-pad row muted">
            <Spinner /> Generating {n} image{n > 1 ? "s" : ""}… this usually takes 5–20 seconds.
          </div>
        )}
        {gens.length === 0 && !busy && (
          <div className="card">
            <Empty icon={<ImageIcon />} title="No images yet" text="Generated images are saved by the gateway and served from /files/images. Costs are per image (premium and >1MP sizes cost more on Nova Canvas)." />
          </div>
        )}
        {gens.map((g) => (
          <div key={g.id} className="card">
            <div className="card-header" style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
              <div className="grow col gap-4" style={{ minWidth: 0 }}>
                <div className="small break">{g.prompt}</div>
                <div className="msg-meta">
                  <span>
                    <b>{g.model || g.requested}</b>
                  </span>
                  <span>{g.size}</span>
                  <span>
                    <b>{money(g.cost, { zero: "$0" })}</b>
                  </span>
                  <span>{duration(g.ms)}</span>
                  {g.requestId && (
                    <Link className="link" to={`/logs?id=${encodeURIComponent(g.requestId)}`}>
                      log
                    </Link>
                  )}
                </div>
              </div>
              <button className="btn ghost icon xs" aria-label="Remove" onClick={() => setGens((gs) => gs.filter((x) => x.id !== g.id))}>
                <Trash2 />
              </button>
            </div>
            <div className="card-body">
              <div className="image-grid">
                {g.urls.map((u, i) => (
                  <div key={u + i} className="image-tile">
                    <img src={u} alt={`${g.prompt} (${i + 1})`} loading="lazy" />
                    <div className="image-actions">
                      <a className="btn icon xs" href={u} target="_blank" rel="noreferrer" aria-label="Open full size">
                        <ExternalLink />
                      </a>
                      <a className="btn icon xs" href={u} download={`image-${i + 1}.png`} aria-label="Download">
                        <Download />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="card pg-side">
        <div className="card-body col gap-12">
          <Field label="Model" htmlFor="img-model">
            <ModelPicker id="img-model" value={model} onChange={setModel} models={models} kinds={["image"]} align="right" />
          </Field>
          <Field label="Prompt" htmlFor="img-prompt">
            <textarea
              id="img-prompt"
              className="textarea"
              rows={5}
              placeholder="A lighthouse on a basalt cliff at dusk, volumetric fog, 35mm photo"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
              }}
            />
          </Field>
          <Field label="Negative prompt" htmlFor="img-neg">
            <input id="img-neg" className="input" placeholder="blurry, text, watermark" value={negative} onChange={(e) => setNegative(e.target.value)} />
          </Field>
          <div className="form-grid">
            <Field label="Size" htmlFor="img-size">
              <select id="img-size" className="select" value={size} onChange={(e) => setSize(e.target.value)}>
                {SIZES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Count" htmlFor="img-n">
              <select id="img-n" className="select" value={n} onChange={(e) => setN(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Quality">
            <Seg
              value={quality}
              onChange={setQuality}
              options={[
                { value: "standard", label: "standard" },
                { value: "premium", label: "premium" },
              ]}
            />
          </Field>
          <Field label="Seed" htmlFor="img-seed" hint="Optional, for reproducible results.">
            <input id="img-seed" className="input mono" type="number" min={0} placeholder="random" value={seed} onChange={(e) => setSeed(e.target.value)} />
          </Field>
          {busy ? (
            <button className="btn" onClick={() => ctrl.current?.abort()}>
              <Square /> Cancel
            </button>
          ) : (
            <button className="btn primary" onClick={generate}>
              <Wand2 /> Generate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================== Speech

const ENGINES = [
  { id: "polly/generative", label: "Generative", engine: "generative" },
  { id: "polly/neural", label: "Neural", engine: "neural" },
  { id: "polly/long-form", label: "Long-form", engine: "long-form" },
  { id: "polly/standard", label: "Standard", engine: "standard" },
];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

interface SpeechOut {
  url: string;
  blob: Blob;
  voice: string | null;
  engine: string | null;
  cost: number | null;
  ms: number;
  chars: number;
  requestId: string | null;
}

export function SpeechMode() {
  const [model, setModel] = useState(() => storage.get("portal.tts.model") || "polly/generative");
  const [voice, setVoice] = useState(() => storage.get("portal.tts.voice") || "Ruth");
  const [input, setInput] = useState("Hello! This is Amazon Polly speaking through your Bedrock Portal gateway.");
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesErr, setVoicesErr] = useState<string | null>(null);
  const [langFilter, setLangFilter] = useState(() => storage.get("portal.tts.lang") || "en-");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<SpeechOut | null>(null);
  const [pricePerM, setPricePerM] = useState<Record<string, number>>({});

  const engine = ENGINES.find((e) => e.id === model)?.engine || "generative";

  useEffect(() => {
    storage.set("portal.tts.model", model);
    let alive = true;
    setVoices(null);
    setVoicesErr(null);
    api
      .get<VoicesResponse>(`/v1/audio/voices?engine=${encodeURIComponent(engine)}`)
      .then((r) => {
        if (!alive) return;
        setVoices(r.data);
        if (r.data.length && !r.data.some((v) => v.id === voice) && !OPENAI_VOICES.includes(voice.toLowerCase())) {
          const en = r.data.find((v) => v.language === "en-US") || r.data[0];
          setVoice(en.id);
        }
      })
      .catch((e) => alive && setVoicesErr(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => storage.set("portal.tts.voice", voice), [voice]);
  useEffect(() => storage.set("portal.tts.lang", langFilter), [langFilter]);

  useEffect(() => {
    api
      .get<PricesResponse>("/api/prices")
      .then((r) => {
        const m: Record<string, number> = {};
        for (const p of r.data) if (p.model_prefix.startsWith("polly/") && p.per_1m_chars) m[p.model_prefix] = p.per_1m_chars;
        setPricePerM(m);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => () => (out ? URL.revokeObjectURL(out.url) : undefined), [out]);

  const languages = useMemo(() => {
    const s = new Map<string, string>();
    for (const v of voices || []) if (v.language) s.set(v.language, v.language_name || v.language);
    return [...s.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [voices]);

  const shownVoices = (voices || []).filter((v) => !langFilter || (v.language || "").startsWith(langFilter));
  const estimate = pricePerM[model] ? (input.length * pricePerM[model]) / 1e6 : null;

  const speak = async () => {
    if (!input.trim()) {
      setErr("Enter some text to speak.");
      return;
    }
    setBusy(true);
    setErr(null);
    const t0 = performance.now();
    try {
      const res = await rawFetch("POST", "/v1/audio/speech", { model, input, voice, speed, response_format: "mp3" });
      const blob = await res.blob();
      const cost = res.headers.get("x-portal-cost-usd");
      setOut({
        url: URL.createObjectURL(blob),
        blob,
        voice: res.headers.get("x-portal-voice") || voice,
        engine: res.headers.get("x-portal-engine"),
        cost: cost !== null ? Number(cost) : null,
        ms: performance.now() - t0,
        chars: input.length,
        requestId: res.headers.get("x-request-id"),
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pg">
      <div className="col gap-12" style={{ minWidth: 0 }}>
        <div className="card">
          <div className="card-body col gap-12">
            <Field
              label="Text"
              htmlFor="tts-input"
              right={
                <span className="mono xs muted">
                  {int(input.length)} chars{estimate !== null ? ` · ≈ ${money(estimate)}` : ""}
                </span>
              }
            >
              <textarea id="tts-input" className="textarea" rows={8} value={input} onChange={(e) => setInput(e.target.value)} />
            </Field>
            {err && <ErrorBanner error={err} />}
            <div className="row">
              <button className="btn primary" onClick={speak} disabled={busy}>
                {busy ? <Spinner /> : <Play />} Synthesize
              </button>
              <span className="xs muted">Long text is split into chunks automatically (up to 100k characters).</span>
            </div>
          </div>
        </div>
        {out ? (
          <div className="card">
            <div className="card-header">
              <AudioLines size={14} className="muted" />
              <div className="card-title grow">Result</div>
              <a className="btn xs" href={out.url} download="speech.mp3">
                <Download /> Download mp3
              </a>
            </div>
            <div className="card-body audio-out">
              <audio controls autoPlay src={out.url} />
              <div className="msg-meta">
                <span>
                  voice <b>{out.voice}</b>
                </span>
                {out.engine && (
                  <span>
                    engine <b>{out.engine}</b>
                  </span>
                )}
                <span>
                  <b>{money(out.cost, { zero: "$0" })}</b>
                </span>
                <span>{int(out.chars)} chars</span>
                <span>{bytes(out.blob.size)}</span>
                <span>{duration(out.ms)}</span>
                {out.requestId && (
                  <Link className="link" to={`/logs?id=${encodeURIComponent(out.requestId)}`}>
                    log
                  </Link>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="card">
            <Empty icon={<AudioLines />} title="No audio yet" text="Text-to-speech uses Amazon Polly. OpenAI voice names (alloy, nova, …) are mapped to Polly voices." />
          </div>
        )}
      </div>
      <div className="card pg-side">
        <div className="card-body col gap-12">
          <Field label="Engine" htmlFor="tts-engine">
            <select id="tts-engine" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {ENGINES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} — {e.id}
                  {pricePerM[e.id] ? ` · $${pricePerM[e.id]}/1M chars` : ""}
                </option>
              ))}
            </select>
          </Field>
          {voicesErr && (
            <Banner kind="warn" title="Couldn't load Polly voices">
              {voicesErr} Using OpenAI voice names instead.
            </Banner>
          )}
          {voices && languages.length > 1 && (
            <Field label="Language" htmlFor="tts-lang">
              <select id="tts-lang" className="select" value={langFilter} onChange={(e) => setLangFilter(e.target.value)}>
                <option value="">All languages</option>
                <option value="en-">English (all)</option>
                {languages.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name} ({code})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Voice" htmlFor="tts-voice" hint={voices ? `${shownVoices.length} voices support the ${engine} engine${langFilter ? " in this language" : ""}.` : undefined}>
            <select id="tts-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices === null && !voicesErr && <option value={voice}>{voice} (loading…)</option>}
              {voices &&
                shownVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name || v.id} · {v.gender?.[0] || "?"} · {v.language}
                  </option>
                ))}
              {voices && !shownVoices.some((v) => v.id === voice) && <option value={voice}>{voice}</option>}
              <optgroup label="OpenAI names (mapped)">
                {OPENAI_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Speed" right={<span className="mono xs">{speed.toFixed(2)}×</span>}>
            <input type="range" min={0.5} max={2} step={0.05} value={speed} aria-label="Speed" onChange={(e) => setSpeed(Number(e.target.value))} />
          </Field>
        </div>
      </div>
    </div>
  );
}

// ============================================================== Transcribe

export function TranscribeMode({ models }: { models: V1Model[] | null }) {
  const toast = useToast();
  const [model, setModel] = useState(() => storage.get("portal.stt.model") || "transcribe");
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; cost: number | null; model: string | null; ms: number; requestId: string | null } | null>(null);
  const [over, setOver] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => storage.set("portal.stt.model", model), [model]);
  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setFileUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      recRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const startRec = async () => {
    setErr(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErr("Recording isn't supported in this browser (or the page isn't served over HTTPS/localhost). Upload a file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunks.current, { type });
        setFile(new File([blob], `recording.${ext}`, { type }));
        setRecording(false);
        if (timer.current) window.clearInterval(timer.current);
      };
      rec.start(250);
      recRef.current = rec;
      setRecording(true);
      const start = Date.now();
      setRecMs(0);
      timer.current = window.setInterval(() => setRecMs(Date.now() - start), 200);
    } catch (e) {
      setErr(`Microphone unavailable: ${errorMessage(e)}`);
    }
  };

  const stopRec = () => recRef.current?.state === "recording" && recRef.current.stop();

  const transcribe = async () => {
    if (!file) {
      setErr("Choose or record an audio file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    const t0 = performance.now();
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("model", model || "transcribe");
      fd.append("response_format", "json");
      if (language.trim()) fd.append("language", language.trim());
      if (prompt.trim()) fd.append("prompt", prompt.trim());
      const res = await rawFetch("POST", "/v1/audio/transcriptions", undefined, { raw: fd });
      const j = (await res.json()) as TranscriptionResult;
      setResult({ text: j.text, cost: j.usage?.cost ?? null, model: res.headers.get("x-portal-model"), ms: performance.now() - t0, requestId: res.headers.get("x-request-id") });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("audio/") && !f.type.startsWith("video/") && !/\.(mp3|mpga|mpeg|m4a|mp4|wav|webm|ogg|oga|opus|flac|aac|mkv|pcm)$/i.test(f.name)) {
      toast.err(`${f.name} doesn't look like an audio file.`);
      return;
    }
    setFile(f);
    setResult(null);
  };

  return (
    <div className="pg">
      <div className="col gap-12" style={{ minWidth: 0 }}>
        <div className="card">
          <div className="card-body col gap-12">
            <div
              className={`drop ${over ? "over" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                pick(e.dataTransfer.files[0]);
              }}
            >
              <Upload />
              <div className="small">
                <b className="text-2">Drop an audio file</b> or click to browse
              </div>
              <div className="xs faint">mp3, m4a, wav, webm, ogg, flac, aac…</div>
            </div>
            <input ref={inputRef} type="file" accept="audio/*,video/mp4,video/webm,.mkv" hidden onChange={(e) => pick(e.target.files?.[0])} />
            <div className="row wrap">
              {recording ? (
                <button className="btn" onClick={stopRec}>
                  <span className="rec-dot" /> Stop recording · <span className="mono">{duration(recMs)}</span>
                </button>
              ) : (
                <button className="btn" onClick={startRec}>
                  <Mic /> Record from microphone
                </button>
              )}
              {file && (
                <span className="chip" style={{ height: 26 }}>
                  <FileAudio />
                  <span className="truncate">{file.name}</span>
                  <span className="faint">{bytes(file.size)}</span>
                  <button aria-label="Remove file" onClick={() => setFile(null)}>
                    <Trash2 />
                  </button>
                </span>
              )}
            </div>
            {fileUrl && <audio controls src={fileUrl} style={{ width: "100%" }} />}
            {err && <ErrorBanner error={err} />}
            <div>
              <button className="btn primary" onClick={transcribe} disabled={busy || !file || recording}>
                {busy ? <Spinner /> : <AudioLines />} Transcribe
              </button>
            </div>
          </div>
        </div>
        {result ? (
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">Transcript</div>
              <CopyButton text={result.text} label="Copy" />
            </div>
            <div className="card-body col gap-8">
              <div className="md" style={{ whiteSpace: "pre-wrap" }}>
                {result.text || <span className="muted">(empty transcript)</span>}
              </div>
              <div className="msg-meta">
                {result.model && (
                  <span>
                    <b>{result.model}</b>
                  </span>
                )}
                <span>
                  <b>{money(result.cost, { zero: "$0" })}</b>
                </span>
                <span>{duration(result.ms)}</span>
                {result.requestId && (
                  <Link className="link" to={`/logs?id=${encodeURIComponent(result.requestId)}`}>
                    log
                  </Link>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="card">
            <Empty icon={<Mic />} title="No transcript yet" text="Uses an audio-capable Bedrock model (Voxtral via the “transcribe” alias) or Amazon Transcribe (aws-transcribe, needs an S3 bucket in Settings → Voice)." />
          </div>
        )}
      </div>
      <div className="card pg-side">
        <div className="card-body col gap-12">
          <Field label="Model" htmlFor="stt-model">
            <ModelPicker
              id="stt-model"
              value={model}
              onChange={setModel}
              models={models}
              kinds={["transcription", "chat"]}
              align="right"
              extra={[
                { id: "transcribe", sub: "alias" },
                { id: "aws-transcribe", sub: "Amazon Transcribe" },
              ]}
            />
          </Field>
          <Field label="Language" htmlFor="stt-lang" hint="Optional ISO code, e.g. en, hi, bn, es. Leave empty to auto-detect.">
            <input id="stt-lang" className="input mono" placeholder="auto" value={language} onChange={(e) => setLanguage(e.target.value)} />
          </Field>
          <Field label="Prompt / vocabulary" htmlFor="stt-prompt" hint="Names, jargon or context that helps accuracy.">
            <textarea id="stt-prompt" className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
        </div>
      </div>
    </div>
  );
}
