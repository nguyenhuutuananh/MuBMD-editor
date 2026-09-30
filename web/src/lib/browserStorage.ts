// browserStorage.ts - Storage on top of the File System Access API (Chrome / Edge).
//
// Every folder or file the user grants is registered in IndexedDB under a stable id and "mounted"
// at a virtual path containing that id:
//   folder "MU"         -> "/MU@3"                    (so an item file is "/MU@3/Data/Items/Group00_Sword.json"
//                                                      and the side data "/MU@3/Data/Items.mubmd/…" lives next to it)
//   file   "ref.tsv"    -> "/ref.tsv@5/ref.tsv"
// A single file has no folder to write side data into, so anything else under its mount (backups,
// anything written next to a picked TSV) goes to the browser's private
// file system (OPFS) under side/<id>/. Mounts from earlier sessions are restored lazily from
// IndexedDB; the browser then asks for permission again if needed (which needs a user click).
// Writes use createWritable(), which the browser commits atomically on close().

import { AppError } from "../../../src/core/errors";
import { normalize } from "../../../src/session/memoryStorage";
import { FileLockedError, type Storage } from "../../../src/session/storage";
import { getHandle, registerHandle } from "./handleDb";

type Mount =
  | { kind: "directory"; id: number; handle: FileSystemDirectoryHandle }
  | { kind: "file"; id: number; handle: FileSystemFileHandle };

type Mode = "read" | "readwrite";

// DOMException -> the error codes the UI already translates.
function mapError(e: unknown, path: string): unknown {
  if (e instanceof AppError) return e;
  const name = (e as DOMException)?.name;
  const file = path.split("/").pop() ?? path;
  switch (name) {
    case "NotFoundError":
      return new AppError("file-not-found", `No such file: ${path}`, { path });
    case "TypeMismatchError":
      return new AppError("not-a-file", `Not a file: ${path}`, { path });
    case "NotAllowedError":
    case "SecurityError":
      return new AppError("permission-denied", `No permission for ${path}`, { path });
    case "NoModificationAllowedError":
    case "InvalidModificationError":
    case "InvalidStateError":
      return new FileLockedError(file);
    case "QuotaExceededError":
      return new AppError("disk-full", "The disk is full.");
    default:
      return e;
  }
}

const notFound = (p: string) => new AppError("file-not-found", `No such file: ${p}`, { path: p });
const mountName = (name: string, id: number) => `${name.replace(/[/\\@]/g, "_") || "item"}@${id}`;

export class BrowserStorage implements Storage {
  private mounts = new Map<string, Mount>();
  private granted = new Set<string>(); // "<mount>|<mode>" already granted this session

  // Register a granted folder / file and return its virtual path (folder root, or the file itself).
  async register(handle: FileSystemDirectoryHandle | FileSystemFileHandle): Promise<string> {
    const id = await registerHandle(handle);
    const name = mountName(handle.name, id);
    this.mounts.set(name, handle.kind === "directory" ? { kind: "directory", id, handle } : { kind: "file", id, handle });
    return handle.kind === "directory" ? `/${name}` : `/${name}/${handle.name}`;
  }

  resolve = (p: string) => normalize(p);
  join = (...parts: string[]) => normalize(parts.join("/"));
  dirname = (p: string) => normalize(`${normalize(p)}/..`);
  basename = (p: string) => normalize(p).split("/").pop() ?? "";

  private async mount(name: string): Promise<Mount> {
    const cached = this.mounts.get(name);
    if (cached) return cached;
    const id = Number(/@(\d+)$/.exec(name)?.[1]);
    const rec = Number.isInteger(id) ? await getHandle(id) : null;
    if (!rec) throw notFound(`/${name}`);
    const m: Mount =
      rec.kind === "directory"
        ? { kind: "directory", id, handle: rec.handle as FileSystemDirectoryHandle }
        : { kind: "file", id, handle: rec.handle as FileSystemFileHandle };
    this.mounts.set(name, m);
    return m;
  }

  // Ask the browser for access if a remembered handle has not been granted in this session yet.
  private async ensure(name: string, handle: FileSystemHandle, mode: Mode) {
    const key = `${name}|${mode}`;
    if (this.granted.has(key) || this.granted.has(`${name}|readwrite`)) return;
    if (typeof handle.queryPermission === "function") {
      let state = await handle.queryPermission({ mode });
      if (state === "prompt") state = await handle.requestPermission({ mode });
      if (state !== "granted") throw new DOMException("Permission denied", "NotAllowedError");
    }
    this.granted.add(key);
  }

  private async sideDir(id: number): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return (await root.getDirectoryHandle("side", { create: true })).getDirectoryHandle(String(id), { create: true });
  }

  // Resolve a virtual path to either the mounted file itself or (folder, name) for a child entry.
  private async locate(
    p: string,
    mode: Mode,
    create: boolean,
  ): Promise<{ file: FileSystemFileHandle } | { dir: FileSystemDirectoryHandle; name: string }> {
    const [name = "", ...parts] = normalize(p).split("/").filter(Boolean);
    if (!parts.length) throw notFound(p);
    const m = await this.mount(name);
    let dir: FileSystemDirectoryHandle;
    if (m.kind === "file") {
      if (parts.length === 1 && parts[0] === m.handle.name) {
        await this.ensure(name, m.handle, mode);
        return { file: m.handle };
      }
      dir = await this.sideDir(m.id); // side data of a file opened / saved on its own
    } else {
      await this.ensure(name, m.handle, mode);
      dir = m.handle;
    }
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name: parts[parts.length - 1]! };
  }

  private async fileHandle(p: string, mode: Mode, create: boolean): Promise<FileSystemFileHandle> {
    const loc = await this.locate(p, mode, create);
    return "file" in loc ? loc.file : loc.dir.getFileHandle(loc.name, { create });
  }

  async read(p: string): Promise<Uint8Array> {
    try {
      const file = await (await this.fileHandle(p, "read", false)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw mapError(e, p);
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      const h = await this.fileHandle(p, "read", false);
      await h.getFile(); // a mounted file that was deleted outside still has a handle
      return true;
    } catch {
      return false;
    }
  }

  async writeAtomic(p: string, bytes: Uint8Array): Promise<void> {
    try {
      const handle = await this.fileHandle(p, "readwrite", true);
      const w = await handle.createWritable();
      try {
        await w.write(bytes as unknown as ArrayBuffer);
        await w.close(); // the file is replaced only now
      } catch (e) {
        await w.abort().catch(() => undefined);
        throw e;
      }
    } catch (e) {
      throw mapError(e, p);
    }
  }

  async remove(p: string): Promise<void> {
    try {
      const loc = await this.locate(p, "readwrite", false);
      if ("file" in loc) return; // never delete a file the user picked
      await loc.dir.removeEntry(loc.name);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotFoundError" || (e instanceof AppError && e.code === "file-not-found")) return;
      throw mapError(e, p);
    }
  }

  // Copy + delete: FileSystemFileHandle.move() is not available everywhere yet.
  async rename(from: string, to: string): Promise<void> {
    await this.writeAtomic(to, await this.read(from));
    await this.remove(from);
  }

  private async entries(dirPath: string, kind: "file" | "directory"): Promise<string[]> {
    try {
      // Locate a (non-existent) child to get the folder itself; normalize() would drop "/.".
      const loc = await this.locate(`${dirPath}/\u0000list`, "read", false);
      if ("file" in loc) return [];
      const names: string[] = [];
      for await (const [name, h] of loc.dir.entries()) if (h.kind === kind) names.push(name);
      return names;
    } catch {
      return [];
    }
  }

  list = (dirPath: string) => this.entries(dirPath, "file");
  listDirs = (dirPath: string) => this.entries(dirPath, "directory");
}
