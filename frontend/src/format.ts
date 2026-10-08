// Formatting helpers: money, compact numbers, durations, relative time.

export function money(v: number | null | undefined, opts: { zero?: string } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n === 0) return opts.zero ?? "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.000001) return `${sign}<$0.000001`;
  if (abs < 0.01) {
    // up to 6 decimals, trimmed to 2 significant digits
    const digits = Math.min(6, Math.max(4, 1 - Math.floor(Math.log10(abs)) + 1));
    const s = abs.toFixed(digits).replace(/0+$/, "");
    return `${sign}$${s.endsWith(".") ? s + "00" : s}`;
  }
  if (abs < 1) return `${sign}$${abs.toFixed(abs < 0.1 ? 4 : 3)}`;
  if (abs >= 100000) return `${sign}$${compact(abs)}`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Price per unit (e.g. per 1M tokens) — trims trailing zeros. */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  let s = v.toFixed(5).replace(/0+$/, "");
  const dec = s.split(".")[1] || "";
  if (dec.length < 2) s = v.toFixed(2);
  return "$" + s;
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const fmt = (x: number, s: string) => {
    const r = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(1);
    return r.replace(/\.0$/, "") + s;
  };
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "k");
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Math.round(v).toLocaleString("en-US");
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function relTime(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return "never";
  const d = now - ts;
  const future = d < 0;
  const a = Math.abs(d);
  let s: string;
  if (a < 10) return future ? "in a moment" : "just now";
  if (a < 60) s = `${Math.round(a)}s`;
  else if (a < 3600) s = `${Math.round(a / 60)}m`;
  else if (a < 86400) s = `${Math.round(a / 3600)}h`;
  else if (a < 86400 * 45) s = `${Math.round(a / 86400)}d`;
  else if (a < 86400 * 365) s = `${Math.round(a / (86400 * 30))}mo`;
  else s = `${(a / (86400 * 365)).toFixed(1)}y`;
  return future ? `in ${s}` : `${s} ago`;
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortTime(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${time.slice(0, 5)}`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dateOnly(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function truncateMiddle(s: string, max = 42): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

export function prettyJson(v: unknown): string {
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Human-short model name: drops region/provider prefixes and version suffixes. */
export function shortModel(id: string | null | undefined): string {
  if (!id) return "unknown";
  let s = id.includes("/") && id.startsWith("arn:") ? id.slice(id.lastIndexOf("/") + 1) : id;
  s = s.replace(/^(global|us|eu|apac|jp|au|ca|in|us-gov)\./, "");
  if (/^[a-z0-9-]+\./.test(s) && !s.startsWith("preset/")) s = s.slice(s.indexOf(".") + 1);
  return s.replace(/-v\d+(:\d+)?$/, "").replace(/:\d+$/, "").replace(/-\d{8}$/, "");
}
