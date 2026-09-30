// storage.ts - The file access a Session needs, independent of the runtime:
//   NodeStorage    (src/server/nodeStorage.ts) - real files via node:fs, for the desktop build
//   MemoryStorage  (memoryStorage.ts)          - in memory, for tests (and a base for the browser build)
// Paths are opaque strings owned by the Storage: only its own path helpers may build or split them.

import { AppError } from "../core";

export interface Storage {
  // path helpers
  resolve(p: string): string; // canonical absolute form, used as identity
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;

  // Missing files reject with a code the API maps to "file-not-found" (ENOENT, or AppError).
  read(p: string): Promise<Uint8Array>;
  exists(p: string): Promise<boolean>;
  isDirectory(p: string): Promise<boolean>;
  // Replaces the file as one step (temp file + rename, or equivalent); creates parent folders.
  // Rejects with FileLockedError when another program holds the file.
  writeAtomic(p: string, bytes: Uint8Array): Promise<void>;
  remove(p: string): Promise<void>; // no error if missing
  rename(from: string, to: string): Promise<void>;
  list(dir: string): Promise<string[]>; // file names in a folder; [] if the folder is missing
  listDirs(dir: string): Promise<string[]>; // sub-folder names in a folder; [] if the folder is missing
}

export class FileLockedError extends AppError {
  constructor(file: string) {
    super("file-locked", `Cannot write ${file}: it is held by another program (is the game client running?).`, { file });
  }
}

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

export async function readText(st: Storage, p: string): Promise<string> {
  return utf8.decode(await st.read(p));
}

// null if the file is missing or unreadable.
export async function tryReadText(st: Storage, p: string): Promise<string | null> {
  try {
    return await readText(st, p);
  } catch {
    return null;
  }
}

export function writeText(st: Storage, p: string, text: string): Promise<void> {
  return st.writeAtomic(p, encoder.encode(text));
}

export async function copyFile(st: Storage, from: string, to: string): Promise<void> {
  await st.writeAtomic(to, await st.read(from));
}

// Split "Game.vi.resx" into { name: "Game.vi", ext: ".resx" }.
export function splitName(fileName: string): { name: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? { name: fileName.slice(0, dot), ext: fileName.slice(dot) } : { name: fileName, ext: "" };
}
