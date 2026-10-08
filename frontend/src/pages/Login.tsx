import { useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { api, errorMessage, setToken } from "../api";
import type { TokenResponse } from "../types";
import { BrandMark } from "../components/Layout";
import { Banner, Spinner } from "../components/ui";
import { useTheme } from "../theme";

export function Login({ mode, onDone, version }: { mode: "setup" | "login"; onDone: () => void; version?: string }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useTheme();

  const setup = mode === "setup";
  const tooShort = setup && pw.length > 0 && pw.length < 8;
  const mismatch = setup && pw2.length > 0 && pw !== pw2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setup && (pw.length < 8 || pw !== pw2)) {
      setErr(pw.length < 8 ? "Password must be at least 8 characters." : "Passwords don't match.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<TokenResponse>(setup ? "/api/auth/setup" : "/api/auth/login", { password: pw });
      setToken(r.token);
      onDone();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <span>Bedrock Portal</span>
          {version && <span className="version">v{version}</span>}
        </div>
        <h1 className="auth-title">{setup ? "Create admin password" : "Sign in"}</h1>
        <p className="auth-sub">
          {setup
            ? "First run. This password protects the dashboard and the admin API. You can change it later in Settings."
            : "Enter the admin password for this gateway."}
        </p>
        <div className="col gap-12">
          {err && <Banner kind="err">{err}</Banner>}
          <div className="field">
            <label htmlFor="pw">Password</label>
            <div className="input-group no-icon">
              <input
                id="pw"
                className="input"
                style={{ paddingRight: 34 }}
                type={show ? "text" : "password"}
                autoComplete={setup ? "new-password" : "current-password"}
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder={setup ? "At least 8 characters" : ""}
              />
              <button
                type="button"
                className="btn ghost icon xs input-suffix"
                aria-label={show ? "Hide password" : "Show password"}
                onClick={() => setShow((s) => !s)}
              >
                {show ? <EyeOff /> : <Eye />}
              </button>
            </div>
            {tooShort && <div className="hint warn-text">{8 - pw.length} more character{8 - pw.length === 1 ? "" : "s"} needed.</div>}
          </div>
          {setup && (
            <div className="field">
              <label htmlFor="pw2">Confirm password</label>
              <input
                id="pw2"
                className="input"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
              {mismatch && <div className="hint err-text">Passwords don't match.</div>}
            </div>
          )}
          <button className="btn primary" style={{ height: 34 }} disabled={busy || !pw || (setup && (pw.length < 8 || pw !== pw2))}>
            {busy ? <Spinner /> : null}
            {setup ? "Create password & continue" : "Sign in"}
            {!busy && <ArrowRight />}
          </button>
          {!setup && (
            <p className="xs muted">
              Forgot it? Delete the <code className="mono">admin_password_hash</code> row from the <code className="mono">settings</code> table in <code className="mono">portal.db</code> and reload — you'll be asked to create a new one.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
