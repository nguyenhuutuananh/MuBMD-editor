// idbStorage.ts - Storage kept in IndexedDB, for browsers without the File System Access API
// (Firefox, Safari, Brave by default). Files are uploaded into it and downloaded out of it
// (see fileTransfer.ts); the Session and its side data (backups, change log, project.json, draft)
// work unchanged. Falls back to memory if IndexedDB is unavailable (e.g. some private modes).

import { AppError } from "../../../src/core/errors";
import { normalize } from "../../../src/session/memoryStorage";
import type { Storage } from "../../../src/session/storage";

const DB_NAME = "mubmd-files";
const STORE = "files";

export class IdbStorage implements Storage {
  private db: Promise<IDBDatabase | null>;
  private memory = new Map<string, Uint8Array>();

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error?.name === "QuotaExceededError" ? new AppError("disk-full", "Browser storage is full.") : req.error);
    });
  }

  resolve = (p: string) => normalize(p);
  join = (...parts: string[]) => normalize(parts.join("/"));
  dirname = (p: string) => normalize(`${normalize(p)}/..`);
  basename = (p: string) => normalize(p).split("/").pop() ?? "";

  async read(p: string): Promise<Uint8Array> {
    const key = normalize(p);
    const v = (await this.db) ? await this.run("readonly", (s) => s.get(key) as IDBRequest<Uint8Array | undefined>) : this.memory.get(key);
    if (!v) throw new AppError("file-not-found", `No such file: ${p}`, { path: p });
    return new Uint8Array(v);
  }

  async exists(p: string): Promise<boolean> {
    const key = normalize(p);
    if (!(await this.db)) return this.memory.has(key);
    return (await this.run("readonly", (s) => s.count(key))) === 1;
  }

  // One IndexedDB put is atomic.
  async writeAtomic(p: string, bytes: Uint8Array): Promise<void> {
    const key = normalize(p);
    if (!(await this.db)) {
      this.memory.set(key, bytes.slice());
      return;
    }
    await this.run("readwrite", (s) => s.put(bytes.slice(), key));
  }

  async remove(p: string): Promise<void> {
    const key = normalize(p);
    if (!(await this.db)) this.memory.delete(key);
    else await this.run("readwrite", (s) => s.delete(key));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.writeAtomic(to, await this.read(from));
    await this.remove(from);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${normalize(dir)}/`;
    const keys = (await this.db) ? ((await this.run("readonly", (s) => s.getAllKeys())) ?? []).map(String) : [...this.memory.keys()];
    return keys.filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
  }
}
