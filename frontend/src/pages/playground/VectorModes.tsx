import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownWideNarrow, Binary, Play } from "lucide-react";
import { errorMessage, rawFetch } from "../../api";
import type { EmbeddingsResult, RerankResult, V1Model } from "../../types";
import { duration, int, money } from "../../format";
import { storage } from "../../storage";
import { ModelPicker } from "../../components/ModelPicker";
import { Empty, ErrorBanner, Field, Spinner } from "../../components/ui";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function heat(v: number): React.CSSProperties {
  // 0 → transparent, 1 → accent
  const t = Math.max(0, Math.min(1, v));
  return { background: `color-mix(in srgb, var(--accent) ${Math.round(t * 70)}%, transparent)`, color: t > 0.6 ? "var(--text)" : undefined };
}

export function EmbeddingsMode({ models }: { models: V1Model[] | null }) {
  const [model, setModel] = useState(() => storage.get("portal.emb.model") || "embed");
  const [text, setText] = useState("The cat sat on the mat.\nA kitten is resting on a rug.\nQuarterly revenue grew 12% year over year.\nStocks rallied after the earnings report.");
  const [dims, setDims] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ inputs: string[]; vectors: number[][]; tokens: number; cost: number; model: string | null; ms: number; requestId: string | null } | null>(null);

  useEffect(() => storage.set("portal.emb.model", model), [model]);

  const run = async () => {
    const inputs = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!inputs.length) {
      setErr("Enter at least one line of text.");
      return;
    }
    setBusy(true);
    setErr(null);
    const t0 = performance.now();
    try {
      const body: Record<string, unknown> = { model: model || "embed", input: inputs };
      if (dims) body.dimensions = Number(dims);
      const r = await rawFetch("POST", "/v1/embeddings", body);
      const j = (await r.json()) as EmbeddingsResult;
      const vectors = [...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      setRes({ inputs, vectors, tokens: j.usage.prompt_tokens, cost: j.usage.cost, model: r.headers.get("x-portal-model"), ms: performance.now() - t0, requestId: r.headers.get("x-request-id") });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const n = res?.vectors.length || 0;
  return (
    <div className="pg">
      <div className="col gap-12" style={{ minWidth: 0 }}>
        <div className="card">
          <div className="card-body col gap-12">
            <Field label="Inputs — one per line" htmlFor="emb-in" right={<span className="mono xs muted">{text.split("\n").filter((s) => s.trim()).length} inputs</span>}>
              <textarea id="emb-in" className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            {err && <ErrorBanner error={err} />}
            <div>
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? <Spinner /> : <Play />} Embed
              </button>
            </div>
          </div>
        </div>
        {res ? (
          <>
            <div className="stats" style={{ "--cols": 4 } as React.CSSProperties}>
              <div className="stat">
                <div className="label">Dimensions</div>
                <div className="stat-value">{res.vectors[0]?.length ?? 0}</div>
              </div>
              <div className="stat">
                <div className="label">Vectors</div>
                <div className="stat-value">{n}</div>
              </div>
              <div className="stat">
                <div className="label">Tokens</div>
                <div className="stat-value">{int(res.tokens)}</div>
              </div>
              <div className="stat">
                <div className="label">Cost</div>
                <div className="stat-value">{money(res.cost, { zero: "$0" })}</div>
                <div className="stat-sub">
                  {res.model} · {duration(res.ms)}
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <div className="card-title grow">Vectors</div>
                {res.requestId && (
                  <Link className="btn ghost xs" to={`/logs?id=${encodeURIComponent(res.requestId)}`}>
                    View log
                  </Link>
                )}
              </div>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Input</th>
                      <th>First values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.vectors.map((v, i) => (
                      <tr key={i}>
                        <td className="mono muted">{i + 1}</td>
                        <td style={{ maxWidth: 280 }} className="truncate" title={res.inputs[i]}>
                          {res.inputs[i]}
                        </td>
                        <td className="vec" style={{ maxWidth: 360 }}>
                          [{v.slice(0, 6).map((x) => x.toFixed(4)).join(", ")}, …]
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {n > 1 && (
              <div className="card">
                <div className="card-header">
                  <div className="card-title grow">Cosine similarity</div>
                  <span className="card-sub">higher = closer in meaning</span>
                </div>
                <div className="table-wrap">
                  <table className="table compact heat">
                    <thead>
                      <tr>
                        <th />
                        {res.inputs.map((_, i) => (
                          <th key={i} className="num" style={{ textAlign: "center" }}>
                            {i + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {res.vectors.map((a, i) => (
                        <tr key={i}>
                          <td className="truncate" style={{ maxWidth: 220 }} title={res.inputs[i]}>
                            <span className="mono muted">{i + 1}</span> {res.inputs[i]}
                          </td>
                          {res.vectors.map((b, j) => {
                            const s = cosine(a, b);
                            return (
                              <td key={j} className="cell" style={heat(i === j ? 0.15 : s)}>
                                {s.toFixed(3)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="card">
            <Empty icon={<Binary />} title="No embeddings yet" text="Titan v2, Cohere Embed and Nova embeddings are supported. The similarity matrix helps sanity-check a model for your domain." />
          </div>
        )}
      </div>
      <div className="card pg-side">
        <div className="card-body col gap-12">
          <Field label="Model" htmlFor="emb-model">
            <ModelPicker id="emb-model" value={model} onChange={setModel} models={models} kinds={["embedding"]} align="right" />
          </Field>
          <Field label="Dimensions" htmlFor="emb-dims" hint="Titan v2: 256 / 512 / 1024. Cohere v4 and Nova support others.">
            <select id="emb-dims" className="select" value={dims} onChange={(e) => setDims(e.target.value)}>
              <option value="">model default</option>
              {[256, 384, 512, 1024, 1536, 3072].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

export function RerankMode({ models }: { models: V1Model[] | null }) {
  const [model, setModel] = useState(() => storage.get("portal.rr.model") || "rerank");
  const [query, setQuery] = useState("How do I rotate an API key?");
  const [docs, setDocs] = useState(
    "API keys can be rotated from the Keys page; the old secret stops working immediately.\nBudgets cap monthly spend per key.\nThe gateway logs every request with tokens and cost.\nRotate credentials regularly and store them in a secrets manager.\nImages are generated with Nova Canvas by default.",
  );
  const [topN, setTopN] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<(RerankResult & { ms: number; resolved: string | null; docs: string[] }) | null>(null);

  useEffect(() => storage.set("portal.rr.model", model), [model]);

  const run = async () => {
    const list = docs
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!query.trim() || !list.length) {
      setErr("A query and at least one document are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    const t0 = performance.now();
    try {
      const body: Record<string, unknown> = { model: model || "rerank", query, documents: list };
      if (topN) body.top_n = Number(topN);
      const r = await rawFetch("POST", "/v1/rerank", body);
      const j = (await r.json()) as RerankResult;
      setRes({ ...j, ms: performance.now() - t0, resolved: r.headers.get("x-portal-model"), docs: list });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const max = res ? Math.max(...res.results.map((r) => r.relevance_score), 0.0001) : 1;
  return (
    <div className="pg">
      <div className="col gap-12" style={{ minWidth: 0 }}>
        <div className="card">
          <div className="card-body col gap-12">
            <Field label="Query" htmlFor="rr-q">
              <input id="rr-q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
            <Field label="Documents — one per line" htmlFor="rr-docs" right={<span className="mono xs muted">{docs.split("\n").filter((s) => s.trim()).length} docs</span>}>
              <textarea id="rr-docs" className="textarea" rows={7} value={docs} onChange={(e) => setDocs(e.target.value)} />
            </Field>
            {err && <ErrorBanner error={err} />}
            <div>
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? <Spinner /> : <ArrowDownWideNarrow />} Rerank
              </button>
            </div>
          </div>
        </div>
        {res ? (
          <div className="card">
            <div className="card-header">
              <div className="card-title grow">Ranked results</div>
              <span className="msg-meta">
                <span>
                  <b>{res.resolved || res.model}</b>
                </span>
                <span>
                  <b>{money(res.usage.cost, { zero: "$0" })}</b>
                </span>
                <span>{duration(res.ms)}</span>
                <Link className="link" to={`/logs?id=${encodeURIComponent(res.id)}`}>
                  log
                </Link>
              </span>
            </div>
            {res.results.map((r, i) => (
              <div key={r.index} className="rank-row">
                <span className="rank">#{i + 1}</span>
                <span className="small break">
                  {r.document?.text ?? res.docs[r.index]}
                  <span className="faint mono xs"> · doc {r.index + 1}</span>
                </span>
                <span className="bar-cell">
                  <span className="minibar">
                    <span style={{ width: `${(r.relevance_score / max) * 100}%` }} />
                  </span>
                  <span className="mono xs">{r.relevance_score.toFixed(4)}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={<ArrowDownWideNarrow />} title="No results yet" text="Cohere Rerank 3.5 or Amazon Rerank reorder documents by relevance to a query. Billed per query of up to 100 documents." />
          </div>
        )}
      </div>
      <div className="card pg-side">
        <div className="card-body col gap-12">
          <Field label="Model" htmlFor="rr-model">
            <ModelPicker id="rr-model" value={model} onChange={setModel} models={models} kinds={["rerank"]} align="right" />
          </Field>
          <Field label="Top N" htmlFor="rr-top" hint="Empty = return every document.">
            <input id="rr-top" className="input mono" type="number" min={1} placeholder="all" value={topN} onChange={(e) => setTopN(e.target.value)} />
          </Field>
        </div>
      </div>
    </div>
  );
}
