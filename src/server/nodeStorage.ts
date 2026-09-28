// nodeStorage.ts - Storage backed by real files (node:fs), used by the desktop build.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLockedError, type Storage } from "../session/storage";

const isLock = (e: unknown) => ["EBUSY", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException)?.code ?? "");

export class NodeStorage implements Storage {
  resolve = (p: string) => path.resolve(p);
  join = (...parts: string[]) => path.join(...parts);
  dirname = (p: string) => path.dirname(p);
  basename = (p: string) => path.basename(p);

  async read(p: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(p));
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  // Temp file in the same folder, then rename over the target: a power loss / crash mid-write
  // never leaves a half-written file.
  async writeAtomic(p: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, bytes);
    } catch (e) {
      if (isLock(e)) throw new FileLockedError(path.basename(p));
      throw e;
    }
    try {
      await fs.rename(tmp, p);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      if (isLock(e)) throw new FileLockedError(path.basename(p));
      throw e;
    }
  }

  async remove(p: string): Promise<void> {
    await fs.rm(p, { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async list(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      return [];
    }
  }
}
