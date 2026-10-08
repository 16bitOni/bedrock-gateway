// Small UI primitives shared by every page.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, Check, Copy, Info, Loader2, MoreHorizontal, X } from "lucide-react";
import { useClickOutside } from "../hooks";

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

// ---------------------------------------------------------------- Modal / Drawer

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
}

function useBodyLock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  size,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  size?: "sm" | "lg";
}) {
  useEscape(onClose);
  useBodyLock();
  const downOnBackdrop = useRef(false);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div className={`modal ${size || ""}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title grow">{title}</div>
          <button className="btn ghost icon sm" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  title,
  children,
  onClose,
  actions,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  useEscape(onClose);
  useBodyLock();
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div className="grow" style={{ minWidth: 0 }}>
            {title}
          </div>
          {actions}
          <button className="btn ghost icon sm" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------- Controls

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: { value: T; label: React.ReactNode; count?: number; icon?: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
  className,
  right,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className={`field ${className || ""}`}>
      <label htmlFor={htmlFor}>
        <span className="grow">{label}</span>
        {right}
      </label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Menu({
  children,
  label = "More actions",
  trigger,
  up,
}: {
  children: (close: () => void) => React.ReactNode;
  label?: string;
  trigger?: React.ReactNode;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {trigger || <MoreHorizontal />}
      </button>
      {open && (
        <div className={`menu ${up ? "up" : ""}`} role="menu" onClick={(e) => e.stopPropagation()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Feedback

export function Skeleton({ w, h = 12, style }: { w?: number | string; h?: number; style?: React.CSSProperties }) {
  return <span className="skeleton" style={{ width: w ?? "100%", height: h, ...style }} />;
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="col" style={{ padding: 14, gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="row gap-16">
          {Array.from({ length: cols }).map((__, j) => (
            <Skeleton key={j} h={10} w={j === 0 ? "26%" : `${10 + ((i * 7 + j * 13) % 14)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
  small,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  text?: React.ReactNode;
  action?: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div className={`empty ${small ? "sm" : ""}`}>
      {icon}
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {action}
    </div>
  );
}

export function Banner({
  kind = "info",
  title,
  children,
  action,
  onClose,
}: {
  kind?: "info" | "warn" | "err" | "accent";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onClose?: () => void;
}) {
  const Icon = kind === "err" ? AlertCircle : kind === "warn" ? AlertTriangle : Info;
  return (
    <div className={`banner ${kind}`} role={kind === "err" ? "alert" : undefined}>
      <Icon />
      <div className="banner-body">
        {title && <div className="banner-title">{title}</div>}
        {children}
      </div>
      {action}
      {onClose && (
        <button className="btn ghost icon xs" aria-label="Dismiss" onClick={onClose}>
          <X />
        </button>
      )}
    </div>
  );
}

/** Inline error banner with the backend's error.message and an optional retry. */
export function ErrorBanner({ error, onRetry, title }: { error: string | null; onRetry?: () => void; title?: string }) {
  if (!error) return null;
  const awsHint = /aws|credential|NoCredentials|AccessDenied|UnrecognizedClient|ExpiredToken|InvalidClientTokenId|security token/i.test(error);
  return (
    <Banner
      kind="err"
      title={title}
      action={
        onRetry && (
          <button className="btn sm" onClick={onRetry}>
            Retry
          </button>
        )
      }
    >
      <span>{error}</span>
      {awsHint && (
        <span className="muted">
          {" "}
          — check <Link className="link" to="/settings#aws">Settings → AWS connection</Link>.
        </span>
      )}
    </Banner>
  );
}

export function Progress({
  value,
  max,
  alertAt,
  thin,
  label,
}: {
  value: number;
  max: number | null | undefined;
  alertAt?: number | null;
  thin?: boolean;
  label?: string;
}) {
  const ratio = max && max > 0 ? value / max : 0;
  const pctAlert = alertAt ? alertAt / 100 : 0.8;
  const tone = !max ? "" : ratio >= 1 ? "err" : ratio >= pctAlert ? "warn" : "";
  return (
    <div
      className={`progress ${thin ? "thin" : ""} ${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      {alertAt ? <div className="marker" style={{ left: `${Math.min(100, alertAt)}%` }} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Copy / code

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label,
  size = "xs",
  className,
  ghost = true,
}: {
  text: string | (() => string);
  label?: string;
  size?: "xs" | "sm";
  className?: string;
  ghost?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${ghost ? "ghost" : ""} ${size} ${label ? "" : "icon"} ${className || ""}`}
      aria-label={label ? undefined : "Copy"}
      title="Copy"
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(typeof text === "function" ? text() : text);
        if (ok) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check className="ok-text" /> : <Copy />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

const JSON_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(text: string): React.ReactNode[] {
  if (text.length > 150_000) return [text];
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    let cls = "tok-num";
    if (tok.startsWith('"')) cls = /:\s*$/.test(tok) ? "tok-key" : "tok-str";
    else if (/^(true|false|null)$/.test(tok)) cls = "tok-kw";
    out.push(
      <span key={i++} className={cls}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const CODE_RE: Record<string, RegExp> = {
  hash: /("""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g,
  slash: /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*)/g,
};

function highlightCode(text: string, lang: string): React.ReactNode[] {
  const re = lang === "js" || lang === "ts" ? CODE_RE.slash : CODE_RE.hash;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const isComment = tok.startsWith("#") || tok.startsWith("//");
    out.push(
      <span key={i++} className={isComment ? "tok-com" : "tok-str"}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function CodeBlock({
  code,
  lang,
  title,
  maxHeight,
  actions,
}: {
  code: string;
  lang?: string;
  title?: React.ReactNode;
  maxHeight?: number;
  actions?: React.ReactNode;
}) {
  const body = lang === "json" ? highlightJson(code) : lang ? highlightCode(code, lang) : code;
  return (
    <div className="code" style={maxHeight ? ({ "--code-max": `${maxHeight}px` } as React.CSSProperties) : undefined}>
      {title !== undefined && (
        <div className="code-head">
          <span className="grow truncate">{title}</span>
          {actions}
          <CopyButton text={code} />
        </div>
      )}
      <pre>
        <code>{body}</code>
      </pre>
      {title === undefined && (
        <span className="code-copy">
          <CopyButton text={code} ghost={false} />
        </span>
      )}
    </div>
  );
}

export function PageHeader({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  loading,
  title,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  loading?: boolean;
  title?: string;
}) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label label">{label}</div>
      {loading ? (
        <>
          <Skeleton h={18} w="60%" style={{ marginTop: 7 }} />
          <Skeleton h={9} w="40%" style={{ marginTop: 8 }} />
        </>
      ) : (
        <>
          <div className="stat-value">{value}</div>
          {sub !== undefined && <div className="stat-sub">{sub}</div>}
        </>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: number }) {
  const cls = status < 300 ? "ok" : status === 429 ? "warn" : "err";
  return <span className={`badge ${cls}`}>{status}</span>;
}
