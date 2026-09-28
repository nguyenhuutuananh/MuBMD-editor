// storage.ts - localStorage an toàn (có thể bị chặn / rỗng -> dùng giá trị mặc định).

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
    /* không lưu được thì thôi */
  }
}

export const KEYS = {
  lang: "mubmd.lang",
  recent: "mubmd.recent",
  filter: "mubmd.filter",
  translator: "mubmd.translator",
} as const;
