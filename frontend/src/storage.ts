// localStorage wrapped in try/catch with an in-memory fallback (private mode, blocked storage).
const memory = new Map<string, string>();

export const storage = {
  get(key: string): string | null {
    try {
      const v = window.localStorage.getItem(key);
      if (v !== null) return v;
    } catch {
      /* storage unavailable */
    }
    return memory.has(key) ? (memory.get(key) as string) : null;
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  remove(key: string): void {
    memory.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
  getJSON<T>(key: string, fallback: T): T {
    const raw = storage.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJSON(key: string, value: unknown): void {
    try {
      storage.set(key, JSON.stringify(value));
    } catch {
      /* not serialisable */
    }
  },
};
