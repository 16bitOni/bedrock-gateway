import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, errorMessage, getToken, onUnauthorized, setToken } from "./api";
import type { AuthStatus } from "./types";
import { Layout } from "./components/Layout";
import { FeedbackProvider } from "./components/feedback";
import { Banner, Spinner } from "./components/ui";
import { ThemeProvider } from "./theme";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Playground } from "./pages/playground/Playground";
import { Models } from "./pages/Models";
import { Keys } from "./pages/Keys";
import { Logs } from "./pages/Logs";
import { Billing } from "./pages/Billing";
import { Quickstart } from "./pages/Quickstart";
import { SettingsPage } from "./pages/Settings";

type Phase = { k: "loading" } | { k: "error"; msg: string } | { k: "setup" } | { k: "login" } | { k: "ready" };

function Gate() {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [version, setVersion] = useState("");

  const check = useCallback(async () => {
    setPhase({ k: "loading" });
    try {
      const s = await api.get<AuthStatus>("/api/auth/status");
      setVersion(s.version);
      if (s.setup_required) {
        setToken(null);
        setPhase({ k: "setup" });
      } else if (s.signed_in && getToken()) setPhase({ k: "ready" });
      else {
        setToken(null);
        setPhase({ k: "login" });
      }
    } catch (e) {
      setPhase({ k: "error", msg: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setPhase((p) => (p.k === "ready" ? { k: "login" } : p));
      }),
    [],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setPhase({ k: "login" });
  }, []);

  if (phase.k === "loading")
    return (
      <div className="splash">
        <Spinner /> Connecting to gateway…
      </div>
    );
  if (phase.k === "error")
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <Banner
            kind="err"
            title="Can't reach the gateway"
            action={
              <button className="btn sm" onClick={check}>
                Retry
              </button>
            }
          >
            {phase.msg}
          </Banner>
        </div>
      </div>
    );
  if (phase.k === "setup" || phase.k === "login")
    return <Login key={phase.k} mode={phase.k} version={version} onDone={() => setPhase({ k: "ready" })} />;

  return (
    <Routes>
      <Route element={<Layout version={version} onSignOut={signOut} />}>
        <Route index element={<Overview />} />
        <Route path="playground" element={<Playground />} />
        <Route path="models" element={<Models />} />
        <Route path="keys" element={<Keys />} />
        <Route path="logs" element={<Logs />} />
        <Route path="billing" element={<Billing />} />
        <Route path="quickstart" element={<Quickstart />} />
        <Route path="settings" element={<SettingsPage onSignOut={signOut} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <FeedbackProvider>
          <Gate />
        </FeedbackProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
