import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { storage } from "./storage";

export type Theme = "dark" | "light";
const KEY = "portal.theme";

interface ThemeApi {
  theme: Theme;
  toggle: () => void;
}

const Ctx = createContext<ThemeApi>({ theme: "dark", toggle: () => undefined });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (storage.get(KEY) === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    storage.set(KEY, theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  const v = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeApi {
  return useContext(Ctx);
}

export interface ChartColors {
  accent: string;
  second: string;
  grid: string;
  text: string;
  muted: string;
  err: string;
  ok: string;
  info: string;
  warn: string;
  surface: string;
  palette: string[];
}

/** Concrete colors for SVG charts, re-read whenever the theme flips. */
export function useChartColors(): ChartColors {
  const { theme } = useTheme();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
    const accent = v("--accent", "#f2a33a");
    const info = v("--info", "#6aa7ff");
    const ok = v("--ok", "#3fb97a");
    const err = v("--err", "#f0645a");
    const second = v("--chart-2", "#8a8a94");
    const dark = theme === "dark";
    return {
      accent,
      second,
      grid: v("--chart-grid", "#1f1f23"),
      text: v("--text-2", "#b4b4bb"),
      muted: v("--muted", "#7d7d86"),
      err,
      ok,
      info,
      warn: v("--warn", "#e6b450"),
      surface: v("--surface", "#121214"),
      // Categorical palette for stacked series; accent first.
      palette: dark
        ? [accent, "#6aa7ff", "#3fb97a", "#c084fc", "#f0645a", "#2dd4bf", "#e6b450", "#94a3b8"]
        : [accent, "#2563eb", "#1d8a52", "#9333ea", "#d0392e", "#0d9488", "#a8740a", "#64748b"],
    };
  }, [theme]);
}
