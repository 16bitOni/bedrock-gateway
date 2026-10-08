import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  BookOpen,
  Boxes,
  CreditCard,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Moon,
  ScrollText,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { api } from "../api";
import type { PortalInfo } from "../types";
import { useTheme } from "../theme";

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--surface-3)" />
      <path d="M7 22 L16 8 L25 22 Z" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M11 22 h10" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/playground", label: "Playground", icon: FlaskConical },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/keys", label: "API Keys", icon: KeyRound },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/quickstart", label: "Quickstart", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

interface InfoCtx {
  info: PortalInfo | null;
  refreshInfo: () => void;
}
const InfoContext = createContext<InfoCtx>({ info: null, refreshInfo: () => undefined });
export const useInfo = () => useContext(InfoContext);

export function Layout({ version, onSignOut }: { version: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api
      .get<PortalInfo>("/api/info")
      .then(setInfo)
      .catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);

  const brand = (
    <div className="brand">
      <BrandMark />
      <span>Bedrock Portal</span>
      <span className="version">v{version}</span>
    </div>
  );

  return (
    <InfoContext.Provider value={{ info, refreshInfo: () => setTick((t) => t + 1) }}>
      <div className="shell">
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Main navigation">
          {brand}
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                <n.icon />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className="region truncate" title="AWS region">
              {info ? info.region : "—"}
            </span>
            <button className="btn ghost icon sm" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </button>
            <button className="btn ghost icon sm" onClick={onSignOut} aria-label="Sign out" title="Sign out">
              <LogOut />
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <button className="btn ghost icon" aria-label="Open navigation" onClick={() => setOpen(true)}>
              <MenuIcon />
            </button>
            {brand}
            <span className="spacer" />
            <button className="btn ghost icon" onClick={toggle} aria-label="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </button>
          </header>
          <Outlet />
        </div>
      </div>
    </InfoContext.Provider>
  );
}
