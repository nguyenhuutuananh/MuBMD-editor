// memoryStorage.ts - Storage kept in a Map with POSIX-style paths. Used by tests; the browser
// build's fallback mode (no File System Access API) builds on it.

import { AppError } from "../core";
import { FileLockedError, type Storage } from "./storage";

export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export class MemoryStorage implements Storage {
  readonly files = new Map<string, Uint8Array>();
  readonly locked = new Set<string>(); // simulate "held by another program"
  private readonly folders = new Set<string>(["/"]);

  constructor(initial: Record<string, Uint8Array> = {}) {
    for (const [p, b] of Object.entries(initial)) this.files.set(normalize(p), b.slice());
  }

  resolve = (p: string) => normalize(p);
  join = (...parts: string[]) => normalize(parts.join("/"));
  dirname = (p: string) => normalize(`${normalize(p)}/..`);
  basename = (p: string) => normalize(p).split("/").pop() ?? "";

  async read(p: string): Promise<Uint8Array> {
    const f = this.files.get(normalize(p));
    if (!f) throw new AppError("file-not-found", `No such file: ${p}`, { path: p });
    return f.slice();
  }

  async exists(p: string): Promise<boolean> {
    return this.files.has(normalize(p));
  }

  // A folder exists as soon as a file lives in it (or when it was created with addFolder).
  async isDirectory(p: string): Promise<boolean> {
    const dir = normalize(p);
    const prefix = dir === "/" ? "/" : `${dir}/`;
    return this.folders.has(dir) || [...this.files.keys()].some((k) => k.startsWith(prefix));
  }

  addFolder(p: string): void {
    this.folders.add(normalize(p));
  }

  async writeAtomic(p: string, bytes: Uint8Array): Promise<void> {
    const key = normalize(p);
    if (this.locked.has(key)) throw new FileLockedError(this.basename(key));
    this.files.set(key, bytes.slice());
  }

  async remove(p: string): Promise<void> {
    this.files.delete(normalize(p));
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(normalize(from));
    if (!f) throw new AppError("file-not-found", `No such file: ${from}`, { path: from });
    this.files.delete(normalize(from));
    this.files.set(normalize(to), f);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${normalize(dir)}/`;
    return [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
  }

  async listDirs(dir: string): Promise<string[]> {
    return subDirs([...this.files.keys(), ...[...this.folders].map((f) => `${f}/`)], dir);
  }
}

// Folder names directly below `dir`, derived from a flat list of file paths.
export function subDirs(keys: string[], dir: string): string[] {
  const prefix = normalize(dir) === "/" ? "/" : `${normalize(dir)}/`;
  const out = new Set<string>();
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut > 0) out.add(rest.slice(0, cut));
  }
  return [...out];
}
