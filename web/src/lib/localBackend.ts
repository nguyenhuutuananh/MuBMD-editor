// localBackend.ts - Web build: the Session runs right here in the browser. Same responses and error
// codes as the desktop HTTP server. Two modes:
//   fs        Chrome / Edge: files are edited in place through the File System Access API (BrowserStorage)
//   fallback  Firefox / Safari / Brave (or "?fallback" in the URL): files are uploaded into IndexedDB
//             (IdbStorage), and saving / exporting downloads the result

import { AppError, NameValidationError } from "../../../src/core";
import { loadGlossaryFile, saveGlossaryFile } from "../../../src/session/glossaryFiles";
import { itemsResponse, saveResponse, stateResponse } from "../../../src/session/responses";
import { Session } from "../../../src/session/session";
import type { PickKind } from "../../../src/shared/api";
import type { Storage } from "../../../src/session/storage";
import { ApiError, type Backend } from "./backend";
import { BrowserStorage } from "./browserStorage";
import { downloadFile, uploadFile } from "./fileTransfer";
import { IdbStorage } from "./idbStorage";

const forceFallback = new URLSearchParams(location.search).has("fallback");
const hasFsAccess = !forceFallback && !!(window.showDirectoryPicker && window.showOpenFilePicker && window.showSaveFilePicker);
const fsStorage = hasFsAccess ? new BrowserStorage() : null;
const storage: Storage = fsStorage ?? new IdbStorage();
const session = new Session(storage);

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

type PickRequest =
  | { mode: "folder" }
  | { mode: "open"; kind: PickKind }
  | { mode: "save"; kind: "bmd" | "tsv" | "glossary"; suggestedName?: string };

// e2e hook: a test answers pickers with its own handles (e.g. from OPFS) instead of real dialogs.
declare global {
  interface Window {
    __MUBMD_TEST_PICK__?: (req: PickRequest) => Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null>;
  }
}

const BMD: FilePickerAcceptType = { description: "Item.bmd", accept: { "application/octet-stream": [".bmd"] } };
const TEXT: FilePickerAcceptType = {
  description: "TSV / CSV",
  accept: { "text/tab-separated-values": [".tsv", ".txt"], "text/csv": [".csv"] },
};
const OPEN_TYPES: Record<PickKind, FilePickerAcceptType[]> = {
  bmd: [BMD],
  "bmd-file": [BMD],
  compare: [BMD],
  tsv: [TEXT],
  glossary: [TEXT],
  reference: [BMD, TEXT],
};

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
    return run(() => window.showDirectoryPicker!({ id: "mubmd-data", mode: "readwrite" }));
  }
  if (req.mode === "open") {
    if (!window.showOpenFilePicker) unsupported();
    const id = req.kind === "tsv" || req.kind === "glossary" ? "mubmd-tsv" : "mubmd-data";
    return run(async () => (await window.showOpenFilePicker!({ id, types: OPEN_TYPES[req.kind] }))[0] ?? null);
  }
  if (!window.showSaveFilePicker) unsupported();
  const types = req.kind === "bmd" ? [BMD] : [TEXT];
  return run(() => window.showSaveFilePicker!({ id: req.kind === "bmd" ? "mubmd-data" : "mubmd-tsv", suggestedName: req.suggestedName, types }));
}

// The user grants a folder (read + write); the Item.bmd inside it is opened, and its side data is
// written next to it like on the desktop.
async function pickFolder(): Promise<string | null> {
  const dir = await pickHandle({ mode: "folder" });
  if (!dir || dir.kind !== "directory") return null;
  const root = await fsStorage!.register(dir);
  const bmds = (await storage.list(root)).filter((n) => /\.bmd$/i.test(n)).sort();
  const file = bmds.find((n) => n.toLowerCase() === "item.bmd") ?? bmds[0];
  if (!file) throw new ApiError(`No .bmd file in ${dir.name}.`, 400, "no-bmd-in-folder", { folder: dir.name });
  return storage.join(root, file);
}

async function pickFile(kind: PickKind): Promise<string | null> {
  const h = await pickHandle({ mode: "open", kind });
  return h && h.kind === "file" ? fsStorage!.register(h) : null;
}

async function pickSaveFile(kind: "bmd" | "tsv" | "glossary", suggestedName?: string): Promise<string | null> {
  const h = await pickHandle({ mode: "save", kind, suggestedName });
  return h && h.kind === "file" ? fsStorage!.register(h) : null;
}

// ---- fallback mode: upload into IndexedDB, download results ----
// Layout: /browser/<name>  working copy of an uploaded Item.bmd (+ its .mubmd side data)
//         /uploads/<name>  other uploaded files (TSV, reference, glossary, compare)
//         /downloads/<name> files written for download (export, glossary); kept so they can be reopened

const ACCEPT: Record<PickKind, string> = {
  bmd: ".bmd",
  "bmd-file": ".bmd",
  compare: ".bmd",
  tsv: ".tsv,.csv,.txt",
  glossary: ".tsv,.csv,.txt",
  reference: ".bmd,.tsv,.csv,.txt",
};
const safeName = (n: string) => n.replace(/[/\\]/g, "_") || "file";
const isDownload = (p: string) => storage.resolve(p).startsWith("/downloads/");

async function upload(kind: PickKind): Promise<string | null> {
  const f = await uploadFile(ACCEPT[kind]);
  if (!f) return null;
  const p = `${kind === "bmd" || kind === "bmd-file" ? "/browser" : "/uploads"}/${safeName(f.name)}`;
  await storage.writeAtomic(p, f.bytes);
  return p;
}

const saveTarget = (kind: "bmd" | "tsv" | "glossary", name?: string) =>
  kind === "bmd" ? `/browser/${safeName(name ?? "Item.bmd")}` : `/downloads/${safeName(name ?? "export.tsv")}`;

async function download(p: string) {
  downloadFile(storage.basename(p), await storage.read(p));
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
  pick: (_lang, kind = "bmd") =>
    call(async () => ({ path: !hasFsAccess ? await upload(kind) : kind === "bmd" ? await pickFolder() : await pickFile(kind) })),
  pickSave: (_lang, kind = "bmd", defaultName) =>
    call(async () => {
      const name = defaultName ?? (kind === "bmd" ? session.file?.fileName : undefined);
      return { path: hasFsAccess ? await pickSaveFile(kind, name) : saveTarget(kind, name) };
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
  importPreview: (path) => call(() => session.previewImport(path)),
  importApply: (path, token, take, translator) => call(() => session.applyImport(path, token, take, translator)),
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
      // Fallback: Item.bmd itself only lives in this browser, so hand the saved file over as a download
      // whenever it was (re)written (not for a status-only save).
      if (!hasFsAccess && (r.backupPath !== null || opts.path)) await download(r.file.path);
      return saveResponse(session, r);
    }),
};
