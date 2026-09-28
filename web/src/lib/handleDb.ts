// handleDb.ts - Remember the folders / files the user granted (File System Access handles are
// storable in IndexedDB), each under a stable numeric id. The id is part of the virtual path
// ("/Local@3/Item.bmd"), so recent files, the remembered reference and glossary, and drafts keep
// working after a reload. The browser may ask for permission again when a handle is reused.

const DB_NAME = "mubmd";
const STORE = "handles";

export interface HandleRecord {
  id: number;
  kind: "file" | "directory";
  name: string;
  handle: FileSystemHandle;
  lastUsed: number;
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
  for (const r of records) {
    if (r.kind === handle.kind && (await r.handle.isSameEntry(handle).catch(() => false))) {
      await put({ ...r, handle, name: handle.name, lastUsed: Date.now() });
      return r.id;
    }
  }
  const rec = { kind: handle.kind, name: handle.name, handle, lastUsed: Date.now() } as Omit<HandleRecord, "id">;
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

export async function getHandle(id: number): Promise<HandleRecord | null> {
  if (memoryFallback) return memoryFallback.find((r) => r.id === id) ?? null;
  return ((await tx("readonly", (s) => s.get(id))) as HandleRecord | undefined) ?? null;
}
