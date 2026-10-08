import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { api } from "../api";
import type { ApiKey } from "../types";
import { useAsync, useDocumentTitle } from "../hooks";
import { useInfo } from "../components/Layout";
import { ModelPicker, useV1Models } from "../components/ModelPicker";
import { CodeBlock, CopyButton, ErrorBanner, Field, PageHeader, Skeleton, Tabs } from "../components/ui";
import { storage } from "../storage";

type Snip = { id: string; label: string; lang: string; title: string; code: string; note?: React.ReactNode };

function snippets(o: { base: string; v1: string; key: string; keyNote: string; model: string }): Snip[] {
  const { base, v1, key, keyNote, model } = o;
  const kc = keyNote ? `# ${keyNote}\n` : "";
  const kcJs = keyNote ? `// ${keyNote}\n` : "";
  return [
    {
      id: "curl",
      label: "curl",
      lang: "sh",
      title: "terminal",
      code: `${kc}curl ${v1}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Say hello in 5 words."}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'`,
    },
    {
      id: "python",
      label: "OpenAI Python",
      lang: "py",
      title: "pip install openai",
      code: `${kc}from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Explain RAG in one paragraph."}],
)
print(resp.choices[0].message.content)
print(resp.usage)  # includes usage.cost (USD) from the gateway

# Streaming with usage in the final chunk
stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Write a haiku about Bedrock."}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)`,
    },
    {
      id: "node",
      label: "OpenAI Node",
      lang: "js",
      title: "npm i openai",
      code: `${kcJs}import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${v1}", apiKey: "${key}" });

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Give me three startup ideas." }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  if (chunk.usage) console.log("\\n", chunk.usage);
}`,
    },
    {
      id: "langchain",
      label: "LangChain",
      lang: "py",
      title: "pip install langchain-openai",
      code: `${kc}from langchain_openai import ChatOpenAI, OpenAIEmbeddings

llm = ChatOpenAI(
    base_url="${v1}",
    api_key="${key}",
    model="${model}",
    stream_usage=True,
)
print(llm.invoke("What is a vector database?").content)

embeddings = OpenAIEmbeddings(
    base_url="${v1}",
    api_key="${key}",
    model="embed",
    check_embedding_ctx_length=False,  # send strings, not token ids
)
vectors = embeddings.embed_documents(["hello", "world"])`,
    },
    {
      id: "llamaindex",
      label: "LlamaIndex",
      lang: "py",
      title: "pip install llama-index-llms-openai-like",
      code: `${kc}from llama_index.llms.openai_like import OpenAILike

llm = OpenAILike(
    api_base="${v1}",
    api_key="${key}",
    model="${model}",
    is_chat_model=True,
    is_function_calling_model=True,
    context_window=200000,
)
print(llm.complete("Summarise the CAP theorem."))`,
    },
    {
      id: "vercel",
      label: "Vercel AI SDK",
      lang: "js",
      title: "npm i ai @ai-sdk/openai-compatible",
      code: `${kcJs}import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";

const portal = createOpenAICompatible({
  name: "bedrock-portal",
  baseURL: "${v1}",
  apiKey: "${key}",
  includeUsage: true,
});

const { text, usage } = await generateText({
  model: portal("${model}"),
  prompt: "Write a tagline for a coffee shop.",
});

const result = streamText({ model: portal("${model}"), prompt: "Count to five." });
for await (const delta of result.textStream) process.stdout.write(delta);`,
    },
    {
      id: "crewai",
      label: "CrewAI",
      lang: "py",
      title: "pip install crewai",
      code: `${kc}from crewai import Agent, LLM

llm = LLM(
    model="openai/${model}",  # the "openai/" prefix selects the OpenAI-compatible provider
    base_url="${v1}",
    api_key="${key}",
)

researcher = Agent(role="Researcher", goal="Find facts", backstory="Thorough analyst", llm=llm)`,
    },
    {
      id: "anthropic",
      label: "Anthropic SDK",
      lang: "py",
      title: "pip install anthropic",
      code: `${kc}from anthropic import Anthropic

# Native Messages API: thinking, tool use, prompt caching and streaming pass straight through.
client = Anthropic(base_url="${base}", auth_token="${key}")  # api_key="${key}" also works

msg = client.messages.create(
    model="${model.startsWith("claude-") ? model : "claude-sonnet-5-5"}",  # Anthropic model names or any alias
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude"}],
)
print(msg.content[0].text)`,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      lang: "sh",
      title: "~/.zshrc or project .env",
      code: `${kc}export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${key}"
export ANTHROPIC_MODEL="${model.startsWith("claude-") ? model : "claude-opus-5-5"}"   # Anthropic names or an alias like "smart"

claude`,
      note: (
        <>
          Claude models on Bedrock need the one-time Anthropic use-case form in the Bedrock console. Claude Code's requests appear in Logs under this key with full token and cost
          accounting.
        </>
      ),
    },
    {
      id: "embeddings",
      label: "Embeddings",
      lang: "py",
      title: "python",
      code: `${kc}from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")
resp = client.embeddings.create(
    model="embed",                # Titan v2; also text-embedding-3-small / embed-multilingual
    input=["first document", "second document"],
    dimensions=512,               # Titan v2: 256 | 512 | 1024
)
print(len(resp.data), len(resp.data[0].embedding), resp.usage)`,
    },
    {
      id: "images",
      label: "Images",
      lang: "py",
      title: "python",
      code: `${kc}from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")
img = client.images.generate(
    model="image",                # Nova Canvas by default; "image-hq" for Stability Ultra
    prompt="An isometric illustration of a tiny data center in a terrarium",
    size="1024x1024",
    quality="standard",           # "premium" / "hd" for higher quality
    n=1,
)
print(img.data[0].url)            # served by the gateway at /files/images/...`,
    },
    {
      id: "tts",
      label: "Text-to-speech",
      lang: "py",
      title: "python",
      code: `${kc}from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")
with client.audio.speech.with_streaming_response.create(
    model="polly/generative",     # or tts-1 (neural) / tts-1-hd (generative)
    voice="Ruth",                 # any Polly voice, or OpenAI names like "alloy"
    input="Your gateway is live.",
    response_format="mp3",
) as resp:
    resp.stream_to_file("speech.mp3")`,
    },
    {
      id: "stt",
      label: "Transcription",
      lang: "py",
      title: "python",
      code: `${kc}from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")
with open("meeting.m4a", "rb") as f:
    tr = client.audio.transcriptions.create(
        model="transcribe",       # Voxtral; "whisper-1" alias also works; "aws-transcribe" for srt/vtt
        file=f,
        language="en",
    )
print(tr.text)`,
    },
    {
      id: "rerank",
      label: "Rerank",
      lang: "sh",
      title: "terminal",
      code: `${kc}curl ${v1}/rerank \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "rerank",
    "query": "How do I reset my password?",
    "documents": ["Billing FAQ", "Password reset steps", "Shipping times"],
    "top_n": 2
  }'`,
    },
  ];
}

export function Quickstart() {
  useDocumentTitle("Quickstart");
  const { info } = useInfo();
  const keys = useAsync((signal) => api.get<{ data: ApiKey[] }>("/api/keys", { signal }), []);
  const { models, error: modelsErr } = useV1Models();
  const [tab, setTab] = useState(() => storage.get("portal.qs.tab") || "python");
  const [keyId, setKeyId] = useState<string>("");
  const [model, setModel] = useState(() => storage.get("portal.qs.model") || "");

  useEffect(() => {
    if (model || !models) return;
    const pick = models.find((m) => m.id === "smart") || models.find((m) => m.owned_by === "alias") || models.find((m) => m.kind === "chat");
    setModel(pick ? pick.id : "smart");
  }, [models, model]);

  const base = info?.base_url || window.location.origin;
  const v1 = info?.openai_base_url || `${base}/v1`;
  const selected = keys.data?.data.find((k) => String(k.id) === keyId);
  const keyNote = selected ? `Key "${selected.name}" (${selected.prefix}…) — paste its full secret where it says YOUR_KEY` : "";
  const list = useMemo(() => snippets({ base, v1, key: "YOUR_KEY", keyNote, model: model || "smart" }), [base, v1, keyNote, model]);
  const cur = list.find((s) => s.id === tab) || list[0];

  return (
    <div className="page">
      <PageHeader title="Quickstart" sub="Point any OpenAI- or Anthropic-compatible client at this gateway." />
      <div className="col gap-16">
        <div className="card">
          <div className="card-body">
            <div className="grid grid-3" style={{ alignItems: "end" }}>
              <Field label="OpenAI base URL">
                <div className="row gap-4">
                  {info ? <code className="mono small truncate grow">{v1}</code> : <Skeleton h={14} />}
                  <CopyButton text={v1} />
                </div>
              </Field>
              <Field label="Anthropic base URL">
                <div className="row gap-4">
                  {info ? <code className="mono small truncate grow">{base}</code> : <Skeleton h={14} />}
                  <CopyButton text={base} />
                </div>
              </Field>
              <Field label="Region">
                <code className="mono small">{info?.region || "—"}</code>
              </Field>
              <Field label="API key" htmlFor="qs-key" hint={keys.data && !keys.data.data.length ? <><Link className="link" to="/keys">Create a key</Link> first — secrets are shown once.</> : "Secrets are only shown at creation, so snippets use YOUR_KEY."}>
                <select id="qs-key" className="select" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                  <option value="">YOUR_KEY (placeholder)</option>
                  {(keys.data?.data || []).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.prefix}… — {k.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Chat model / alias" htmlFor="qs-model">
                <ModelPicker
                  id="qs-model"
                  value={model}
                  onChange={(m) => {
                    setModel(m);
                    storage.set("portal.qs.model", m);
                  }}
                  models={models}
                  kinds={["chat"]}
                />
              </Field>
              <div className="xs muted" style={{ paddingBottom: 6 }}>
                {info?.aliases?.length ? (
                  <>
                    {info.aliases.length} aliases available, e.g. <code className="mono">{info.aliases.slice(0, 4).join(", ")}</code>
                  </>
                ) : (
                  "No aliases yet — sync models to create defaults."
                )}
              </div>
            </div>
            {modelsErr && (
              <div className="mt-8">
                <ErrorBanner error={modelsErr} />
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div style={{ padding: "0 6px" }}>
            <Tabs
              value={cur.id}
              onChange={(t) => {
                setTab(t);
                storage.set("portal.qs.tab", t);
              }}
              tabs={list.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
          <div className="card-body col gap-8">
            <CodeBlock title={cur.title} lang={cur.lang} code={cur.code} maxHeight={560} />
            {cur.note && <div className="xs muted">{cur.note}</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <BookOpen size={14} className="muted" />
            <div className="card-title grow">Gateway features</div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {FEATURES.map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono small" style={{ width: 280, verticalAlign: "top", paddingTop: 8 }}>
                      {k}
                    </td>
                    <td className="wrap small text-2">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES: [string, React.ReactNode][] = [
  ["x-portal-cache: 1", <>Request header. Serve identical non-streaming chat/embedding requests from the exact-match cache (free, TTL in Settings). Can also be enabled per key.</>],
  ["x-portal-session: <id>", <>Request header. Groups requests into a session you can filter on the Logs page (agents, conversations, CI runs).</>],
  ["x-request-id", <>Response header. The log id — open it in Logs for the full transcript and cost.</>],
  ["x-portal-cost-usd", <>Response header with the computed cost of the call (non-streaming responses).</>],
  ["x-portal-model", <>Response header with the Bedrock model that actually served the request (after alias resolution and fallbacks).</>],
  ["usage.cost", <>Extra field in the OpenAI usage object (and the final streaming chunk with <code>stream_options.include_usage</code>) with the cost in USD.</>],
  ['model: "preset/<name>"', <>Use a preset: its model, system prompt and default params are applied. Manage them on <Link className="link" to="/models?tab=presets">Models → Presets</Link>.</>],
  ['model: "<alias>"', <>Aliases resolve to an ordered fallback chain — throttling, missing access or context overflow fail over to the next target.</>],
  ["reasoning_effort", <>low / medium / high is mapped to Claude extended thinking budgets, Nova reasoning config and gpt-oss effort. Thinking streams as <code>reasoning_content</code>.</>],
  ["response_format", <><code>json_schema</code> is enforced through a structured-output tool call (forced where the model supports it); <code>json_object</code> is enforced by instruction.</>],
  ["tools / tool_choice", <>OpenAI function calling, including parallel calls and streaming arguments, mapped to the Bedrock Converse tool API.</>],
  ["/v1/messages", <>Native Anthropic Messages API (Claude Code, Anthropic SDK) with the same keys, budgets and logging.</>],
];
