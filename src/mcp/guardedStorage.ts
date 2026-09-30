// guardedStorage.ts - The MCP server reads the workspace but may only write below one folder
// (.mumain-translator/proposals/): translated files, the project file, drafts and backups belong to
// the person using MuMain-translator. Any other write is refused (and the Session code that tries one
// in passing - carrying over old side data, resetting merge bases - only logs a warning).

import { AppError } from "../core";
import type { Storage } from "../session/storage";

export class GuardedStorage implements Storage {
  private allowed: string;

  constructor(
    private readonly inner: Storage,
    allowedDir: string,
  ) {
    this.allowed = inner.resolve(allowedDir);
  }

  resolve = (p: string) => this.inner.resolve(p);
  join = (...parts: string[]) => this.inner.join(...parts);
  dirname = (p: string) => this.inner.dirname(p);
  basename = (p: string) => this.inner.basename(p);
  read = (p: string) => this.inner.read(p);
  exists = (p: string) => this.inner.exists(p);
  isDirectory = (p: string) => this.inner.isDirectory(p);
  list = (dir: string) => this.inner.list(dir);
  listDirs = (dir: string) => this.inner.listDirs(dir);

  private check(p: string) {
    let d = this.inner.resolve(p);
    for (let up = this.inner.dirname(d); up !== d; d = up, up = this.inner.dirname(d)) {
      if (up === this.allowed) return;
    }
    throw new AppError("permission-denied", `The MCP server only writes proposals, not ${p}.`, { path: p });
  }

  async writeAtomic(p: string, bytes: Uint8Array) {
    this.check(p);
    await this.inner.writeAtomic(p, bytes);
  }

  async remove(p: string) {
    this.check(p);
    await this.inner.remove(p);
  }

  async rename(from: string, to: string) {
    this.check(from);
    this.check(to);
    await this.inner.rename(from, to);
  }
}
