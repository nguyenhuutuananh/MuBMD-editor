// storage.ts - Safe localStorage (may be blocked / empty -> fall back to defaults).

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore: nothing to do if it cannot be saved */
  }
}

export const KEYS = {
  lang: "mubmd.lang",
  recent: "mubmd.recent",
  filter: "mubmd.filter",
  translator: "mubmd.translator",
} as const;
