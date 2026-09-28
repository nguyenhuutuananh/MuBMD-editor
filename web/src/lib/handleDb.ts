// handleDb.ts - Remember the folders / files the user granted (File System Access handles are
// storable in IndexedDB), each under a stable numeric id. The id is part of the virtual path
// ("/Local@3/Item.bmd"), so recent files, the remembered reference and glossary, and drafts keep
// working after a reload. The browser may ask for permission again when a handle is reused.
//
// Handles inside the browser's private file system (OPFS) are stored by their path instead of as
// handle objects: Chromium 153 crashes the whole browser when an OPFS directory handle is read back
// from IndexedDB after a reload. (Handles of the user's own files/folders are stored as usual.)

const DB_NAME = "mubmd";
const STORE = "handles";

export interface HandleRecord {
  id: number;
  kind: "file" | "directory";
  name: string;
  handle?: FileSystemHandle; // a user-granted file / folder
  opfsPath?: string[]; // or: the path of an OPFS entry (see above)
  lastUsed: number;
}

// The path of `h` inside OPFS, or null if it is a normal (user-granted) handle.
async function opfsPathOf(h: FileSystemHandle): Promise<string[] | null> {
  try {
    return await (await navigator.storage.getDirectory()).resolve(h);
  } catch {
    return null;
  }
}

async function fromOpfs(parts: string[], kind: "file" | "directory"): Promise<FileSystemHandle> {
  let dir = await navigator.storage.getDirectory();
  const last = kind === "file" ? parts.length - 1 : parts.length;
  for (const part of parts.slice(0, last)) dir = await dir.getDirectoryHandle(part);
  return kind === "file" ? dir.getFileHandle(parts[parts.length - 1]!) : dir;
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function sameEntry(r: HandleRecord, handle: FileSystemHandle, opfs: string[] | null): Promise<boolean> {
  if (r.kind !== handle.kind) return false;
  if (r.opfsPath || opfs) return !!r.opfsPath && !!opfs && samePath(r.opfsPath, opfs);
  return (await r.handle?.isSameEntry(handle).catch(() => false)) ?? false;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let memoryFallback: HandleRecord[] | null = null; // IndexedDB unavailable (e.g. some private modes)

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

async function all(): Promise<HandleRecord[]> {
  if (memoryFallback) return memoryFallback;
  try {
    return await tx("readonly", (s) => s.getAll() as IDBRequest<HandleRecord[]>);
  } catch {
    memoryFallback = [];
    return memoryFallback;
  }
}

// Returns the id of `handle`, reusing the id of an earlier grant of the same file/folder.
export async function registerHandle(handle: FileSystemHandle): Promise<number> {
  const records = await all();
  const opfs = await opfsPathOf(handle);
  const stored = opfs ? { opfsPath: opfs } : { handle };
  for (const r of records) {
    if (await sameEntry(r, handle, opfs)) {
      await put({ id: r.id, kind: r.kind, name: handle.name, ...stored, lastUsed: Date.now() });
      return r.id;
    }
  }
  const rec = { kind: handle.kind, name: handle.name, ...stored, lastUsed: Date.now() } as Omit<HandleRecord, "id">;
  if (memoryFallback) {
    const id = (memoryFallback.at(-1)?.id ?? 0) + 1;
    memoryFallback.push({ ...rec, id });
    return id;
  }
  return Number(await tx("readwrite", (s) => s.add(rec)));
}

async function put(r: HandleRecord): Promise<void> {
  if (memoryFallback) {
    memoryFallback = memoryFallback.map((x) => (x.id === r.id ? r : x));
    return;
  }
  await tx("readwrite", (s) => s.put(r));
}

// The record with a usable `handle` (OPFS entries are looked up again by path).
export async function getHandle(id: number): Promise<(HandleRecord & { handle: FileSystemHandle }) | null> {
  const r = memoryFallback
    ? memoryFallback.find((x) => x.id === id)
    : ((await tx("readonly", (s) => s.get(id))) as HandleRecord | undefined);
  if (!r) return null;
  if (r.handle) return r as HandleRecord & { handle: FileSystemHandle };
  if (!r.opfsPath) return null;
  return { ...r, handle: await fromOpfs(r.opfsPath, r.kind) };
}
