import { Link } from "react-router-dom";
import { Brain, ChevronRight, CornerDownRight, Wrench } from "lucide-react";
import type { ToolCall } from "../../types";
import { compact, duration, money, prettyJson } from "../../format";
import { Markdown } from "../../components/Markdown";
import { CopyButton } from "../../components/ui";
import type { MsgMeta } from "./chat";

export function Thinking({ text, streaming, defaultOpen }: { text: string; streaming?: boolean; defaultOpen?: boolean }) {
  if (!text) return null;
  return (
    <details className="thinking" open={defaultOpen || streaming}>
      <summary>
        <ChevronRight className="chev" />
        <Brain />
        <span>{streaming ? "Thinking…" : "Thinking"}</span>
        <span className="faint mono xs">{compact(text.length)} chars</span>
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  return (
    <div className="tool-card">
      <div className="tool-head">
        <Wrench />
        <span className="grow truncate">
          {call.function.name || "tool"}
          <span className="faint">()</span>
        </span>
        {call.id && <span className="faint xs truncate" style={{ maxWidth: 160 }}>{call.id}</span>}
        <CopyButton text={call.function.arguments || ""} />
      </div>
      <pre>{prettyJson(call.function.arguments || "{}")}</pre>
    </div>
  );
}

export function ToolResultCard({ id, content, name }: { id?: string; content: string; name?: string }) {
  return (
    <div className="tool-card result">
      <div className="tool-head">
        <CornerDownRight />
        <span className="grow truncate">Tool result{name ? ` · ${name}` : ""}</span>
        {id && <span className="faint xs truncate" style={{ maxWidth: 160 }}>{id}</span>}
      </div>
      <pre>{prettyJson(content)}</pre>
    </div>
  );
}

export function MetaLine({ meta, requested }: { meta: MsgMeta; requested?: string }) {
  const u = meta.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens || 0;
  return (
    <div className="msg-meta">
      {meta.model && (
        <span title="Model actually used (x-portal-model)">
          <b>{meta.model}</b>
          {requested && requested !== meta.model ? <span className="faint"> ← {requested}</span> : null}
          {meta.attempt && meta.attempt !== "1" ? <span className="warn-text"> · fallback #{meta.attempt}</span> : null}
        </span>
      )}
      {u && (
        <span>
          <b>{compact(u.prompt_tokens)}</b> in · <b>{compact(u.completion_tokens)}</b> out
          {cached ? <span> · {compact(cached)} cached</span> : null}
        </span>
      )}
      {u?.cost !== undefined && (
        <span>
          <b>{money(u.cost, { zero: "$0" })}</b>
        </span>
      )}
      {meta.cached && <span className="ok-text">cache hit</span>}
      {meta.ttft !== null && <span>TTFT {duration(meta.ttft)}</span>}
      {meta.total !== null && <span>total {duration(meta.total)}</span>}
      {meta.finish && meta.finish !== "stop" && <span className="warn-text">{meta.finish}</span>}
      {meta.requestId && (
        <Link className="link" to={`/logs?id=${encodeURIComponent(meta.requestId)}`}>
          {meta.requestId.slice(0, 12)}…
        </Link>
      )}
    </div>
  );
}

export function AssistantBody({ content, reasoning, toolCalls, streaming }: { content: string; reasoning?: string; toolCalls?: ToolCall[]; streaming?: boolean }) {
  const thinkingNow = streaming && !content && !toolCalls?.length;
  return (
    <div className="col gap-8">
      {reasoning ? <Thinking text={reasoning} streaming={thinkingNow} /> : null}
      {content || (streaming && !reasoning && !toolCalls?.length) ? <Markdown text={content} streaming={streaming && !toolCalls?.length} /> : null}
      {toolCalls?.map((t, i) => <ToolCallCard key={t.id || i} call={t} />)}
    </div>
  );
}
