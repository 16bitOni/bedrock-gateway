// Tiny, safe markdown renderer (no innerHTML): fences, inline code, bold/italic, links, lists, headings, quotes.
import { memo } from "react";
import { CodeBlock } from "./ui";

type Block =
  | { t: "code"; lang: string; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; start: number; items: string[] }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "p"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ t: "p", text: para.join("\n") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const lang = fence[2] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run past the end while streaming)
      blocks.push({ t: "code", lang, text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }
    const ol = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ol) {
      flush();
      const items: string[] = [];
      const start = parseInt(ol[1], 10);
      while (i < lines.length && (/^\s*\d+[.)]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      blocks.push({ t: "ol", start, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ t: "quote", text: q.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string, keyBase = ""): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  INLINE_RE.lastIndex = 0;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    else if (m[4]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm)
        out.push(
          <a key={key} href={lm[2]} target="_blank" rel="noreferrer noopener">
            {lm[1]}
          </a>,
        );
    } else if (m[5])
      out.push(
        <a key={key} href={tok} target="_blank" rel="noreferrer noopener">
          {tok}
        </a>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LANG_MAP: Record<string, string> = { python: "py", py: "py", bash: "sh", sh: "sh", shell: "sh", js: "js", javascript: "js", ts: "js", typescript: "js", tsx: "js", jsx: "js", json: "json" };

function MarkdownImpl({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = parse(text);
  return (
    <div className={`md ${streaming ? "cursor-host" : ""}`}>
      {blocks.map((b, i) => {
        const last = streaming && i === blocks.length - 1;
        switch (b.t) {
          case "code":
            return <CodeBlock key={i} code={b.text} lang={LANG_MAP[b.lang.toLowerCase()] || (b.lang ? "py" : undefined)} title={b.lang || "code"} />;
          case "h": {
            const Tag = (`h${Math.min(4, b.level)}` as unknown) as "h1";
            return <Tag key={i}>{inline(b.text, `h${i}`)}</Tag>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `u${i}.${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `o${i}.${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={i}>{inline(b.text, `q${i}`)}</blockquote>;
          case "hr":
            return <hr key={i} />;
          default:
            return (
              <p key={i} className={last ? "cursor-blink" : undefined}>
                {inline(b.text, `p${i}`)}
              </p>
            );
        }
      })}
      {streaming && (blocks.length === 0 || blocks[blocks.length - 1].t !== "p") && <span className="cursor-blink" />}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
