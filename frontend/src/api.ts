// Typed fetch wrapper for the Bedrock Portal backend.
import type { ChatChunk } from "./types";
import { storage } from "./storage";

const TOKEN_KEY = "portal.token";
let memoryToken: string | null = storage.get(TOKEN_KEY);
const unauthorizedListeners = new Set<() => void>();

export function getToken(): string | null {
  return memoryToken;
}

export function setToken(token: string | null): void {
  memoryToken = token;
  if (token) storage.set(TOKEN_KEY, token);
  else storage.remove(TOKEN_KEY);
}

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

function emitUnauthorized() {
  setToken(null);
  unauthorizedListeners.forEach((fn) => fn());
}

export class ApiError extends Error {
  status: number;
  type: string | null;
  code: string | null;
  param: string | null;
  constructor(status: number, message: string, type?: string | null, code?: string | null, param?: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type ?? null;
    this.code = code ?? null;
    this.param = param ?? null;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof DOMException && e.name === "AbortError") return "Request cancelled.";
  if (e instanceof TypeError) return `Network error: ${e.message}. Is the gateway running?`;
  if (e instanceof Error) return e.message;
  return String(e);
}

interface ErrorBody {
  error?: { message?: string; type?: string; code?: string; param?: string } | string;
  type?: string;
  detail?: unknown;
  message?: string;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? (JSON.parse(text) as ErrorBody) : null;
  } catch {
    body = null;
  }
  const err = body?.error;
  if (err && typeof err === "object") {
    return new ApiError(res.status, err.message || `HTTP ${res.status}`, err.type, err.code, err.param);
  }
  if (typeof err === "string") return new ApiError(res.status, err);
  if (body?.message) return new ApiError(res.status, body.message);
  if (body?.detail) return new ApiError(res.status, typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
  return new ApiError(res.status, text.slice(0, 300) || `HTTP ${res.status} ${res.statusText}`);
}

function authHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const t = getToken();
  if (t && !h.has("Authorization")) h.set("Authorization", `Bearer ${t}`);
  return h;
}

function isAdminPath(path: string): boolean {
  return path.startsWith("/api/") && !path.startsWith("/api/auth/status") && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/setup");
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  /** Raw body (FormData etc.) — skips JSON encoding. */
  raw?: BodyInit;
}

/** Low-level fetch with auth + error extraction. Returns the Response when ok. */
export async function rawFetch(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
  const headers = authHeaders(opts.headers);
  let payload: BodyInit | undefined = opts.raw;
  if (payload === undefined && body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, signal: opts.signal });
  if (!res.ok) {
    const err = await toApiError(res);
    // A 401 on the dashboard API (or on /v1 with the admin token) means the session is gone.
    if (res.status === 401 && (isAdminPath(path) || (path.startsWith("/v1/") && getToken()?.startsWith("adm.")))) {
      if (err.code !== "invalid_password") emitUnauthorized();
    }
    throw err;
  }
  return res;
}

export async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const res = await rawFetch(method, path, body, opts);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Fetch a URL with auth and trigger a browser download of the response body. */
export async function downloadAuthed(path: string, fallbackName: string): Promise<void> {
  const res = await rawFetch("GET", path);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const m = /filename="?([^";]+)"?/i.exec(cd);
  saveBlob(blob, m ? m[1] : fallbackName);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// SSE streaming for /v1/chat/completions
// ---------------------------------------------------------------------------

export interface StreamMeta {
  requestId: string | null;
  model: string | null;
  attempt: string | null;
}

export interface StreamHandlers {
  onOpen?: (meta: StreamMeta) => void;
  onChunk: (chunk: ChatChunk) => void;
}

/** POST a streaming chat completion and parse the SSE stream manually. Resolves when [DONE] arrives. */
export async function streamChat(body: Record<string, unknown>, handlers: StreamHandlers, signal?: AbortSignal, extraHeaders?: HeadersInit): Promise<StreamMeta> {
  const res = await rawFetch("POST", "/v1/chat/completions", { ...body, stream: true, stream_options: { include_usage: true } }, {
    signal,
    headers: extraHeaders,
  });
  const meta: StreamMeta = {
    requestId: res.headers.get("x-request-id"),
    model: res.headers.get("x-portal-model"),
    attempt: res.headers.get("x-portal-attempt"),
  };
  handlers.onOpen?.(meta);
  if (!res.body) throw new ApiError(500, "Streaming is not supported by this browser.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data) return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    const o = obj as { error?: { message?: string; type?: string; code?: string; param?: string } };
    if (o && o.error) {
      throw new ApiError(502, o.error.message || "Stream error", o.error.type, o.error.code, o.error.param);
    }
    handlers.onChunk(obj as ChatChunk);
  };

  while (!done) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      handleLine(line);
      if (done) break;
    }
  }
  if (!done && buffer.trim()) handleLine(buffer.trim());
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return meta;
}
