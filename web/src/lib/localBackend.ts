// localBackend.ts - Web build: the Session runs right here in the browser. Same responses and error
// codes as the desktop HTTP server. Two modes:
//   fs        Chrome / Edge: the game folder is edited in place through the File System Access API (BrowserStorage)
//   fallback  Firefox / Safari / Brave (or "?fallback" in the URL): the game folder's item files are
//             uploaded into IndexedDB (IdbStorage), and saving / exporting downloads the result

import { AppError, NameValidationError, looksLikeItemFile } from "../../../src/core";
import type { Platform } from "../../../src/session/itemsFolder";
import { loadGlossaryFile, saveGlossaryFile } from "../../../src/session/glossaryFiles";
import { itemsResponse, saveResponse, stateResponse } from "../../../src/session/responses";
import { Session } from "../../../src/session/session";
import { FOLDER_KINDS, type PickKind, type SaveKind } from "../../../src/shared/api";
import type { Storage } from "../../../src/session/storage";
import { ApiError, type Backend } from "./backend";
import { BrowserStorage } from "./browserStorage";
import { downloadFile, uploadFile, uploadFolder } from "./fileTransfer";
import { IdbStorage } from "./idbStorage";
import { zip } from "./zip";

const forceFallback = new URLSearchParams(location.search).has("fallback");
const hasFsAccess = !forceFallback && !!(window.showDirectoryPicker && window.showOpenFilePicker && window.showSaveFilePicker);
const fsStorage = hasFsAccess ? new BrowserStorage() : null;
const storage: Storage = fsStorage ?? new IdbStorage();

// The OS of this computer: decides which build layout wins when a game folder holds several.
function browserPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || "";
  if (/mac/i.test(p)) return "darwin";
  if (/win/i.test(p)) return "win32";
  if (/linux|x11|cros/i.test(p)) return "linux";
  return "other";
}

const session = new Session(storage, undefined, browserPlatform());

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof NameValidationError) return new ApiError(e.message, 422, e.code, e.params, e.check.issues);
  if (e instanceof AppError) return new ApiError(e.message, 400, e.code, e.params);
  console.error(e);
  const detail = e instanceof Error ? e.message : String(e);
  return new ApiError(detail, 500, "internal", { detail });
}

async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toApiError(e);
  }
}

const isAbort = (e: unknown) => (e as DOMException)?.name === "AbortError";

type FolderKind = "game" | "compare";
type PickRequest =
  | { mode: "folder"; kind: FolderKind }
  | { mode: "open"; kind: PickKind }
  | { mode: "save"; kind: SaveKind; suggestedName?: string };

// e2e hook: a test answers pickers with its own handles (e.g. from OPFS) instead of real dialogs.
declare global {
  interface Window {
    __MUBMD_TEST_PICK__?: (req: PickRequest) => Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null>;
  }
}

const TEXT: FilePickerAcceptType = {
  description: "TSV / CSV",
  accept: { "text/tab-separated-values": [".tsv", ".txt"], "text/csv": [".csv"] },
};
const isFolderKind = (kind: PickKind): kind is FolderKind => FOLDER_KINDS.includes(kind);

function unsupported(): never {
  throw new ApiError("This browser cannot edit files in place.", 0, "fs-unsupported");
}

// Run a picker; null when the user cancels.
async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

async function pickHandle(req: PickRequest): Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null> {
  if (window.__MUBMD_TEST_PICK__) return window.__MUBMD_TEST_PICK__(req);
  if (req.mode === "folder") {
    if (!window.showDirectoryPicker) unsupported();
    // The game folder is written to; a folder to compare with is only read.
    return run(() => window.showDirectoryPicker!({ id: "mubmd-game", mode: req.kind === "game" ? "readwrite" : "read" }));
  }
  if (req.mode === "open") {
    if (!window.showOpenFilePicker) unsupported();
    return run(async () => (await window.showOpenFilePicker!({ id: "mubmd-tsv", types: [TEXT] }))[0] ?? null);
  }
  if (!window.showSaveFilePicker) unsupported();
  return run(() => window.showSaveFilePicker!({ id: "mubmd-tsv", suggestedName: req.suggestedName, types: [TEXT] }));
}

// The user grants the game folder; the Session finds Data/Items inside it (itemsFolder.ts) and keeps
// its side data next to it like on the desktop.
async function pickFolder(kind: FolderKind): Promise<string | null> {
  const dir = await pickHandle({ mode: "folder", kind });
  return dir && dir.kind === "directory" ? fsStorage!.register(dir) : null;
}

async function pickFile(kind: PickKind): Promise<string | null> {
  const h = await pickHandle({ mode: "open", kind });
  return h && h.kind === "file" ? fsStorage!.register(h) : null;
}

async function pickSaveFile(kind: SaveKind, suggestedName?: string): Promise<string | null> {
  const h = await pickHandle({ mode: "save", kind, suggestedName });
  return h && h.kind === "file" ? fsStorage!.register(h) : null;
}

// ---- fallback mode: upload into IndexedDB, download results ----
// Layout: /browser/<folder>/...  item files of an uploaded game folder (+ the Items.mubmd side data)
//         /uploads/<folder or name>  other uploaded files / folders (TSV, reference, glossary, compare)
//         /downloads/<name> files written for download (export, glossary); kept so they can be reopened

const safeName = (n: string) => n.replace(/[/\\]/g, "_") || "file";
const isDownload = (p: string) => storage.resolve(p).startsWith("/downloads/");

// Only the item files of a game folder are read (a whole game folder has thousands of other files):
// *.json directly in a folder named "Items", or named like Group00_Sword.json.
function isUploadedItemFile(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1]!;
  if (!/\.json$/i.test(name)) return false;
  return parts[parts.length - 2]?.toLowerCase() === "items" || looksLikeItemFile(name);
}

async function upload(kind: PickKind): Promise<string | null> {
  if (isFolderKind(kind)) {
    const up = await uploadFolder(isUploadedItemFile);
    if (!up) return null;
    const base = kind === "game" ? "/browser" : "/uploads";
    if (!up.files.length) throw new AppError("items-not-found", `No item data in ${up.root}.`, { folder: up.root });
    for (const f of up.files) await storage.writeAtomic(`${base}/${f.path}`, f.bytes);
    return `${base}/${safeName(up.root)}`;
  }
  const f = await uploadFile(".tsv,.csv,.txt");
  if (!f) return null;
  const p = `/uploads/${safeName(f.name)}`;
  await storage.writeAtomic(p, f.bytes);
  return p;
}

async function download(p: string) {
  downloadFile(storage.basename(p), await storage.read(p));
}

// Fallback: the saved item files only live in this browser, so hand them over: one file as it is,
// several as Items.zip.
async function downloadSaved(written: string[]) {
  if (written.length === 1) return download(written[0]!);
  const files = await Promise.all(written.map(async (p) => ({ name: storage.basename(p), bytes: await storage.read(p) })));
  downloadFile("Items.zip", zip(files));
}

export const backend: Backend = {
  kind: "local",
  state: () => call(() => stateResponse(session, __APP_VERSION__)),
  items: () => call(() => itemsResponse(session)),
  open: (path, discard = false) =>
    call(async () => {
      await session.open(path, { discard });
      return stateResponse(session, __APP_VERSION__);
    }),
  fallback: !hasFsAccess,
  pick: (_lang, kind = "game") =>
    call(async () => ({ path: !hasFsAccess ? await upload(kind) : isFolderKind(kind) ? await pickFolder(kind) : await pickFile(kind) })),
  pickSave: (_lang, kind = "tsv", defaultName) =>
    call(async () => {
      const name = defaultName ?? (kind === "tsv" ? "export.tsv" : "Glossary.tsv");
      return { path: hasFsAccess ? await pickSaveFile(kind, name) : `/downloads/${safeName(name)}` };
    }),
  edit: (slot, name, translator) => call(() => session.edit(slot, name, translator)),
  revert: (slot, translator) => call(() => session.revert(slot, translator)),
  status: (slots, status, translator) => call(() => session.setStatus(slots, status, translator)),
  note: (slot, note, translator) => call(() => session.setNote(slot, note, translator)),
  reference: (path) => call(async () => ({ reference: await session.setReference(path) })),
  exportTsv: (path, slots) =>
    call(async () => {
      const r = await session.exportTsv(path, slots);
      if (!hasFsAccess && isDownload(r.path)) await download(r.path);
      return r;
    }),
  importPreview: (path, source) => call(() => session.previewImport(path, source)),
  importApply: (path, token, take, translator, source) => call(() => session.applyImport(path, token, take, translator, source)),
  glossaryLoad: (path) => call(() => loadGlossaryFile(storage, path)),
  glossarySave: (path, entries) =>
    call(async () => {
      const g = await saveGlossaryFile(storage, path, entries);
      if (!hasFsAccess && isDownload(g.path)) await download(g.path);
      return g;
    }),
  undo: () => call(() => session.undo()),
  redo: () => call(() => session.redo()),
  restoreDraft: () => call(() => session.restoreDraft()),
  discardDraft: () =>
    call(async () => {
      await session.discardDraft();
      return { ok: true as const };
    }),
  save: (opts = {}) =>
    call(async () => {
      const r = await session.save(opts);
      // Not for a status-only save (nothing rewritten).
      if (!hasFsAccess && r.written.length) await downloadSaved(r.written);
      return saveResponse(session, r);
    }),
};
