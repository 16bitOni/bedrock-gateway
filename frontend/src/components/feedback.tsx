// Toasts and confirm dialogs (custom modal — never window.confirm/alert).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Modal } from "./ui";

type ToastKind = "ok" | "err" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  ok: (text: string) => void;
  err: (text: string) => void;
  info: (text: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Require typing this text to enable the confirm button. */
  typeToConfirm?: string;
}

const ConfirmCtx = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-4), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "err" ? 7000 : 3500);
    },
    [dismiss],
  );
  const toastApi = useMemo<ToastApi>(
    () => ({ ok: (t) => push("ok", t), err: (t) => push("err", t), info: (t) => push("info", t) }),
    [push],
  );

  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ ...o, resolve });
      }),
    [],
  );

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === "ok" ? <CheckCircle2 /> : t.kind === "err" ? <XCircle /> : <Info />}
              <div>{t.text}</div>
              <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X />
              </button>
            </div>
          ))}
        </div>
        {confirmState && (
          <ConfirmDialog
            opts={confirmState}
            onClose={(v) => {
              confirmState.resolve(v);
              setConfirmState(null);
            }}
          />
        )}
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

function ConfirmDialog({ opts, onClose }: { opts: ConfirmOptions; onClose: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!opts.typeToConfirm) btnRef.current?.focus();
  }, [opts.typeToConfirm]);
  const blocked = !!opts.typeToConfirm && typed !== opts.typeToConfirm;
  return (
    <Modal
      title={
        <span className="row">
          {opts.danger && <AlertTriangle size={15} className="err-text" />}
          {opts.title}
        </span>
      }
      size="sm"
      onClose={() => onClose(false)}
      footer={
        <>
          <button className="btn" onClick={() => onClose(false)}>
            {opts.cancelLabel || "Cancel"}
          </button>
          <button
            ref={btnRef}
            className={`btn ${opts.danger ? "danger solid" : "primary"}`}
            disabled={blocked}
            onClick={() => onClose(true)}
          >
            {opts.confirmLabel || "Confirm"}
          </button>
        </>
      }
    >
      <div className="col gap-12 text-2">
        {opts.body && <div>{opts.body}</div>}
        {opts.typeToConfirm && (
          <div className="field">
            <label htmlFor="confirm-type">
              Type <code className="mono">{opts.typeToConfirm}</code> to confirm
            </label>
            <input
              id="confirm-type"
              className="input mono"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocked) onClose(true);
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastCtx);
  if (!t) throw new Error("useToast outside FeedbackProvider");
  return t;
}

export function useConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error("useConfirm outside FeedbackProvider");
  return c;
}
