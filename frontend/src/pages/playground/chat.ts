// Chat helpers shared by Chat and Compare modes: message model, request building, streaming, codegen.
import { rawFetch, streamChat } from "../../api";
import type { ChatUsage, ToolCall } from "../../types";

export type Role = "user" | "assistant" | "tool";

export interface MsgMeta {
  model: string | null;
  requestId: string | null;
  attempt: string | null;
  usage: ChatUsage | null;
  ttft: number | null;
  total: number | null;
  finish: string | null;
  cached?: boolean;
}

export interface ChatMsg {
  id: string;
  role: Role;
  content: string;
  images?: string[];
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  meta?: MsgMeta;
  error?: string;
  streaming?: boolean;
}

export type Effort = "none" | "low" | "medium" | "high";
export type RespFormat = "text" | "json_object" | "json_schema";

export interface ChatParams {
  temperature: number | null;
  max_tokens: number | null;
  reasoning_effort: Effort;
  response_format: RespFormat;
  json_schema: string;
  tools_enabled: boolean;
  tools: string;
  cache: boolean;
}

export const DEFAULT_PARAMS: ChatParams = {
  temperature: null,
  max_tokens: null,
  reasoning_effort: "none",
  response_format: "text",
  json_schema: JSON.stringify(
    {
      name: "answer",
      strict: true,
      schema: {
        type: "object",
        properties: { answer: { type: "string" }, confidence: { type: "number" } },
        required: ["answer", "confidence"],
        additionalProperties: false,
      },
    },
    null,
    2,
  ),
  tools_enabled: false,
  tools: JSON.stringify(
    [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
            required: ["city"],
          },
        },
      },
    ],
    null,
    2,
  ),
  cache: false,
};

let idSeq = 0;
export const uid = () => `m${Date.now().toString(36)}${(idSeq++).toString(36)}`;

type OAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type OAIMessage = Record<string, unknown>;

export function toOpenAIMessages(system: string, msgs: ChatMsg[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system.trim()) out.push({ role: "system", content: system });
  for (const m of msgs) {
    if (m.error && m.role === "assistant" && !m.content && !m.toolCalls?.length) continue;
    if (m.role === "user") {
      if (m.images?.length) {
        const parts: OAIContentPart[] = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
        out.push({ role: "user", content: parts });
      } else out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: OAIMessage = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length)
        msg.tool_calls = m.toolCalls.map((t, i) => ({
          id: t.id || `call_${i}`,
          type: "function",
          function: { name: t.function.name, arguments: t.function.arguments || "{}" },
        }));
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId || "", content: m.content });
    }
  }
  return out;
}

export class ParamError extends Error {}

export function buildBody(model: string, system: string, msgs: ChatMsg[], p: ChatParams): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: toOpenAIMessages(system, msgs) };
  if (p.temperature !== null) body.temperature = p.temperature;
  if (p.max_tokens) body.max_tokens = p.max_tokens;
  if (p.reasoning_effort !== "none") body.reasoning_effort = p.reasoning_effort;
  if (p.response_format === "json_object") body.response_format = { type: "json_object" };
  if (p.response_format === "json_schema") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.json_schema);
    } catch (e) {
      throw new ParamError(`JSON schema is not valid JSON: ${(e as Error).message}`);
    }
    const o = parsed as Record<string, unknown>;
    const js = o && typeof o === "object" && "schema" in o ? o : { name: "response", strict: true, schema: o };
    body.response_format = { type: "json_schema", json_schema: js };
  }
  if (p.tools_enabled && p.tools.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.tools);
    } catch (e) {
      throw new ParamError(`Tools are not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new ParamError("Tools must be a JSON array.");
    body.tools = parsed.map((t: Record<string, unknown>) => (t && t.type === "function" ? t : { type: "function", function: t }));
  }
  return body;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  meta: MsgMeta;
}

/** Stream a chat completion, calling onUpdate with the accumulated state (throttled to animation frames). */
export async function runChat(
  body: Record<string, unknown>,
  onUpdate: (r: StreamResult) => void,
  signal: AbortSignal,
  cache: boolean,
): Promise<StreamResult> {
  const t0 = performance.now();
  const r: StreamResult = {
    content: "",
    reasoning: "",
    toolCalls: [],
    meta: { model: null, requestId: null, attempt: null, usage: null, ttft: null, total: null, finish: null },
  };
  if (cache) {
    // The exact-match cache only applies to non-streaming calls, so send one.
    try {
      const res = await rawFetch("POST", "/v1/chat/completions", body, { signal, headers: { "x-portal-cache": "1" } });
      const j = (await res.json()) as {
        choices: { message: { content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: string | null }[];
        usage?: ChatUsage;
      };
      const ch = j.choices?.[0];
      r.content = ch?.message?.content || "";
      r.reasoning = ch?.message?.reasoning_content || "";
      r.toolCalls = ch?.message?.tool_calls || [];
      r.meta = {
        model: res.headers.get("x-portal-model"),
        requestId: res.headers.get("x-request-id"),
        attempt: res.headers.get("x-portal-attempt"),
        // A cache hit is free, but the cached body still carries the original usage.cost.
        usage: j.usage ? (res.headers.get("x-portal-cache") === "hit" ? { ...j.usage, cost: 0 } : j.usage) : null,
        ttft: null,
        total: performance.now() - t0,
        finish: ch?.finish_reason || null,
        cached: res.headers.get("x-portal-cache") === "hit",
      };
      onUpdate(r);
      return r;
    } finally {
      r.meta.total = performance.now() - t0;
    }
  }
  let raf = 0;
  const flush = () => {
    raf = 0;
    onUpdate({ ...r, toolCalls: r.toolCalls.map((t) => ({ ...t, function: { ...t.function } })), meta: { ...r.meta } });
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(flush);
  };
  try {
    await streamChat(
      body,
      {
        onOpen: (m) => {
          r.meta.model = m.model;
          r.meta.requestId = m.requestId;
          r.meta.attempt = m.attempt;
          schedule();
        },
        onChunk: (c) => {
          if (c.usage) r.meta.usage = c.usage;
          for (const ch of c.choices || []) {
            const d = ch.delta || {};
            const gotToken = !!(d.content || d.reasoning_content || d.tool_calls?.length);
            if (gotToken && r.meta.ttft === null) r.meta.ttft = performance.now() - t0;
            if (d.content) r.content += d.content;
            if (d.reasoning_content) r.reasoning += d.reasoning_content;
            for (const tc of d.tool_calls || []) {
              const slot = r.toolCalls[tc.index] || (r.toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: "", arguments: "" } });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name = tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
            if (ch.finish_reason) r.meta.finish = ch.finish_reason;
          }
          schedule();
        },
      },
      signal,
      cache ? { "x-portal-cache": "1" } : undefined,
    );
  } finally {
    if (raf) cancelAnimationFrame(raf);
    r.meta.total = performance.now() - t0;
    r.toolCalls = r.toolCalls.filter(Boolean);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Replay: turn a logged request body into playground state
// ---------------------------------------------------------------------------

interface AnyBlock {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  thinking?: string;
}

function blocksToParts(content: unknown): { text: string; images: string[]; toolUses: ToolCall[]; toolResults: { id: string; text: string }[]; thinking: string } {
  const res = { text: "", images: [] as string[], toolUses: [] as ToolCall[], toolResults: [] as { id: string; text: string }[], thinking: "" };
  if (typeof content === "string") {
    res.text = content;
    return res;
  }
  if (!Array.isArray(content)) return res;
  const texts: string[] = [];
  for (const b of content as AnyBlock[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "image_url") {
      const u = typeof b.image_url === "string" ? b.image_url : b.image_url?.url;
      if (u && !u.includes("<")) res.images.push(u);
    } else if (b.type === "image" && b.source) {
      if (b.source.type === "base64" && b.source.data && !b.source.data.startsWith("<")) res.images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      else if (b.source.url) res.images.push(b.source.url);
    } else if (b.type === "tool_use") res.toolUses.push({ id: b.id, type: "function", function: { name: b.name || "", arguments: JSON.stringify(b.input ?? {}) } });
    else if (b.type === "tool_result") res.toolResults.push({ id: b.tool_use_id || "", text: blocksToParts(b.content).text || (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) });
    else if (b.type === "thinking" && b.thinking) res.thinking += b.thinking;
  }
  res.text = texts.join("\n");
  return res;
}

export interface ReplayState {
  model: string;
  system: string;
  messages: ChatMsg[];
  params: Partial<ChatParams>;
}

export function replayFromBody(endpoint: string, body: unknown): ReplayState | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: ReplayState = { model: String(b.model || ""), system: "", messages: [], params: {} };
  const msgs = Array.isArray(b.messages) ? (b.messages as Record<string, unknown>[]) : [];
  if (endpoint === "messages") {
    // Anthropic Messages API
    if (typeof b.system === "string") out.system = b.system;
    else if (Array.isArray(b.system)) out.system = blocksToParts(b.system).text;
    for (const m of msgs) {
      const p = blocksToParts(m.content);
      if (m.role === "user") {
        for (const tr of p.toolResults) out.messages.push({ id: uid(), role: "tool", content: tr.text, toolCallId: tr.id });
        if (p.text || p.images.length) out.messages.push({ id: uid(), role: "user", content: p.text, images: p.images });
      } else if (m.role === "assistant") {
        out.messages.push({ id: uid(), role: "assistant", content: p.text, toolCalls: p.toolUses.length ? p.toolUses : undefined, reasoning: p.thinking || undefined });
      }
    }
    if (typeof b.max_tokens === "number") out.params.max_tokens = b.max_tokens;
    if (typeof b.temperature === "number") out.params.temperature = b.temperature;
    const thinking = b.thinking as { type?: string; budget_tokens?: number } | undefined;
    if (thinking && thinking.type && thinking.type !== "disabled") out.params.reasoning_effort = "medium";
    if (Array.isArray(b.tools) && b.tools.length) {
      out.params.tools_enabled = true;
      out.params.tools = JSON.stringify(
        (b.tools as Record<string, unknown>[]).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        null,
        2,
      );
    }
    return out;
  }
  const sys: string[] = [];
  for (const m of msgs) {
    const role = String(m.role || "");
    const p = blocksToParts(m.content);
    if (role === "system" || role === "developer") sys.push(p.text);
    else if (role === "user") out.messages.push({ id: uid(), role: "user", content: p.text, images: p.images.length ? p.images : undefined });
    else if (role === "assistant") {
      const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCall[]) : undefined;
      out.messages.push({ id: uid(), role: "assistant", content: p.text, toolCalls: tcs?.length ? tcs : undefined, reasoning: typeof m.reasoning_content === "string" ? m.reasoning_content : undefined });
    } else if (role === "tool") out.messages.push({ id: uid(), role: "tool", content: p.text, toolCallId: String(m.tool_call_id || "") });
  }
  out.system = sys.join("\n\n");
  if (typeof b.temperature === "number") out.params.temperature = b.temperature;
  const mt = (b.max_completion_tokens ?? b.max_tokens) as number | undefined;
  if (typeof mt === "number") out.params.max_tokens = mt;
  const eff = (b.reasoning_effort as string | undefined) || ((b.reasoning as { effort?: string } | undefined)?.effort ?? undefined);
  if (eff === "low" || eff === "medium" || eff === "high") out.params.reasoning_effort = eff;
  else if (eff === "minimal") out.params.reasoning_effort = "low";
  else if (eff === "xhigh" || eff === "max") out.params.reasoning_effort = "high";
  const rf = b.response_format as { type?: string; json_schema?: unknown } | undefined;
  if (rf?.type === "json_object") out.params.response_format = "json_object";
  if (rf?.type === "json_schema") {
    out.params.response_format = "json_schema";
    out.params.json_schema = JSON.stringify(rf.json_schema ?? {}, null, 2);
  }
  if (Array.isArray(b.tools) && b.tools.length) {
    out.params.tools_enabled = true;
    out.params.tools = JSON.stringify(b.tools, null, 2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function scrubImages(v: unknown): unknown {
  if (typeof v === "string") return v.startsWith("data:") && v.length > 120 ? v.slice(0, 40) + "…<base64 image>" : v;
  if (Array.isArray(v)) return v.map(scrubImages);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubImages(x)]));
  return v;
}

function pyLiteral(v: unknown, indent = 0): string {
  const pad = "    ".repeat(indent);
  const pad1 = "    ".repeat(indent + 1);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return "[\n" + v.map((x) => pad1 + pyLiteral(x, indent + 1)).join(",\n") + ",\n" + pad + "]";
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  return "{\n" + entries.map(([k, x]) => `${pad1}${JSON.stringify(k)}: ${pyLiteral(x, indent + 1)}`).join(",\n") + ",\n" + pad + "}";
}

export function codegen(lang: "python" | "curl" | "js", baseUrl: string, rawBody: Record<string, unknown>, stream: boolean, cache: boolean): string {
  const body = scrubImages(rawBody) as Record<string, unknown>;
  const { model, messages, ...rest } = body;
  if (lang === "curl") {
    const full = stream ? { ...body, stream: true, stream_options: { include_usage: true } } : body;
    const json = JSON.stringify(full, null, 2).replace(/'/g, "'\\''");
    return [
      `curl ${baseUrl}/chat/completions \\`,
      `  -H "Authorization: Bearer $PORTAL_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      ...(cache ? [`  -H "x-portal-cache: 1" \\`] : []),
      ...(stream ? [`  -N \\`] : []),
      `  -d '${json}'`,
    ].join("\n");
  }
  if (lang === "python") {
    // OpenAI SDK: non-standard params go through extra_body
    const std = new Set(["temperature", "max_tokens", "response_format", "tools", "tool_choice", "top_p", "stop", "seed", "reasoning_effort"]);
    const kw: string[] = [`    model=${JSON.stringify(model)},`, `    messages=${pyLiteral(messages, 1)},`];
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (std.has(k)) kw.push(`    ${k}=${pyLiteral(v, 1)},`);
      else extra[k] = v;
    }
    if (Object.keys(extra).length) kw.push(`    extra_body=${pyLiteral(extra, 1)},`);
    if (cache) kw.push(`    extra_headers={"x-portal-cache": "1"},`);
    if (stream) {
      kw.push(`    stream=True,`);
      kw.push(`    stream_options={"include_usage": True},`);
    }
    const head = [
      "import os",
      "from openai import OpenAI",
      "",
      "client = OpenAI(",
      `    base_url=${JSON.stringify(baseUrl)},`,
      `    api_key=os.environ["PORTAL_API_KEY"],`,
      ")",
      "",
    ];
    if (stream)
      return [
        ...head,
        "stream = client.chat.completions.create(",
        ...kw,
        ")",
        "for chunk in stream:",
        "    if chunk.choices and chunk.choices[0].delta.content:",
        '        print(chunk.choices[0].delta.content, end="", flush=True)',
        "    if chunk.usage:",
        '        print(f"\\n\\n{chunk.usage.prompt_tokens} in / {chunk.usage.completion_tokens} out")',
      ].join("\n");
    return [...head, "resp = client.chat.completions.create(", ...kw, ")", "print(resp.choices[0].message.content)", "print(resp.usage)"].join("\n");
  }
  const params = JSON.stringify(stream ? { ...body, stream: true, stream_options: { include_usage: true } } : body, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : "  " + l))
    .join("\n");
  const head = [
    'import OpenAI from "openai";',
    "",
    "const client = new OpenAI({",
    `  baseURL: ${JSON.stringify(baseUrl)},`,
    "  apiKey: process.env.PORTAL_API_KEY,",
    "});",
    "",
  ];
  const opts = cache ? `, { headers: { "x-portal-cache": "1" } }` : "";
  if (stream)
    return [
      ...head,
      `const stream = await client.chat.completions.create(${params}${opts});`,
      "for await (const chunk of stream) {",
      '  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");',
      "  if (chunk.usage) console.log(\"\\n\", chunk.usage);",
      "}",
    ].join("\n");
  return [...head, `const resp = await client.chat.completions.create(${params}${opts});`, "console.log(resp.choices[0].message.content);"].join("\n");
}

/** The assistant message from a logged response body (OpenAI chat completion or Anthropic message). */
export function responseToMsg(endpoint: string, body: unknown): ChatMsg | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (endpoint === "messages") {
    if (Array.isArray(b.content)) {
      const p = blocksToParts(b.content);
      return { id: uid(), role: "assistant", content: p.text, toolCalls: p.toolUses.length ? p.toolUses : undefined, reasoning: p.thinking || undefined };
    }
    if (typeof b.text === "string") return { id: uid(), role: "assistant", content: b.text };
    return null;
  }
  const choices = b.choices as { message?: Record<string, unknown> }[] | undefined;
  const m = choices?.[0]?.message;
  if (!m) return null;
  const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCall[]) : undefined;
  return {
    id: uid(),
    role: "assistant",
    content: typeof m.content === "string" ? m.content : blocksToParts(m.content).text,
    toolCalls: tcs?.length ? tcs : undefined,
    reasoning: typeof m.reasoning_content === "string" ? m.reasoning_content : undefined,
  };
}
