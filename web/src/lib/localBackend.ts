// localBackend.ts - Web build: the Session runs right here in the browser. Same responses and error
// codes as the desktop HTTP server. Two modes:
//   fs        Chrome / Edge: the folder the user grants is edited in place through the File System
//             Access API (BrowserStorage)
//   fallback  Firefox / Safari / Brave (or "?fallback" in the URL): the translatable files of the
//             chosen folder are uploaded into IndexedDB (IdbStorage); saving downloads the written
//             files (one as it is, several as a zip laid out like the folder), exporting downloads
//             the TSV

import { AppError } from "../../../src/core";
import { loadGlossaryFile, saveGlossaryFile } from "../../../src/session/glossaryFiles";
import type { Platform } from "../../../src/session/itemsFolder";
import { Session } from "../../../src/session/session";
import type { PickKind, SaveKind, StateResponse } from "../../../src/shared/api";
import { ApiError, type Backend } from "./backend";
import { BrowserStorage } from "./browserStorage";
import { downloadFile, uploadFile, uploadFolder } from "./fileTransfer";
import { IdbStorage } from "./idbStorage";
import { isTranslatableUpload } from "./uploadFilter";
import { zip } from "./zip";

const forceFallback = new URLSearchParams(location.search).has("fallback");
export const hasFsAccess = !forceFallback && !!(window.showDirectoryPicker && window.showOpenFilePicker && window.showSaveFilePicker);
const fsStorage = hasFsAccess ? new BrowserStorage() : null;
const idb = hasFsAccess ? null : new IdbStorage();
const storage = fsStorage ?? idb!;
// The OS of this computer: decides which game layout wins when a folder holds several.
function browserPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || "";
  if (/mac/i.test(p)) return "darwin";
  if (/win/i.test(p)) return "win32";
  if (/linux|x11|cros/i.test(p)) return "linux";
  return "other";
}

const session = new Session(storage, undefined, browserPlatform());

const STATUS: Record<string, number> = { "no-folder": 409, dirty: 409, conflict: 409, "import-changed": 409, "not-editable": 422 };

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof AppError) return new ApiError(e.message, STATUS[e.code] ?? 400, e.code, e.params);
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

type PickRequest = { mode: "folder" } | { mode: "open"; kind: PickKind } | { mode: "save"; kind: SaveKind; suggestedName?: string };

// e2e hook: a test answers pickers with its own handles (from OPFS) instead of real dialogs.
declare global {
  interface Window {
    __MUMAIN_TR_TEST_PICK__?: (req: PickRequest) => Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null>;
  }
}

const TEXT: FilePickerAcceptType = {
  description: "TSV / CSV",
  accept: { "text/tab-separated-values": [".tsv", ".txt"], "text/csv": [".csv"] },
};
const ZIP: FilePickerAcceptType = { description: "ZIP", accept: { "application/zip": [".zip"] } };
// A translation file to import: TSV / CSV or a package (.zip).
const IMPORT: FilePickerAcceptType = {
  description: "TSV / CSV / ZIP",
  accept: { "text/tab-separated-values": [".tsv", ".txt"], "text/csv": [".csv"], "application/zip": [".zip"] },
};

function unsupported(): never {
  throw new ApiError("This browser cannot edit files in place.", 0, "fs-unsupported");
}

// Run a picker; null when the user cancels.
async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

async function pickHandle(req: PickRequest): Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null> {
  if (window.__MUMAIN_TR_TEST_PICK__) return window.__MUMAIN_TR_TEST_PICK__(req);
  if (!hasFsAccess) unsupported();
  if (req.mode === "folder") return run(() => window.showDirectoryPicker!({ id: "mumain-translator-folder", mode: "readwrite" }));
  if (req.mode === "open") return run(async () => (await window.showOpenFilePicker!({ id: "mumain-translator-tsv", types: [req.kind === "tsv" ? IMPORT : TEXT] }))[0] ?? null);
  return run(() => window.showSaveFilePicker!({ id: "mumain-translator-tsv", suggestedName: req.suggestedName, types: [req.kind === "zip" ? ZIP : TEXT] }));
}

// The user grants a folder (read + write): it becomes "/<name>@<id>"; the Session finds what can be
// translated in it (workspace.ts).
async function pick(kind: PickKind): Promise<string | null> {
  if (!fsStorage) return upload(kind);
  const h = await pickHandle(kind === "folder" ? { mode: "folder" } : { mode: "open", kind });
  if (!h) return null;
  if (kind === "folder" ? h.kind !== "directory" : h.kind !== "file") return null;
  return fsStorage.register(h);
}

async function pickSave(kind: SaveKind, suggestedName?: string): Promise<string | null> {
  if (!fsStorage) return `/downloads/${safeName(suggestedName ?? { tsv: "export.tsv", glossary: "Glossary.tsv", zip: "translations.zip" }[kind])}`;
  const h = await pickHandle({ mode: "save", kind, suggestedName });
  return h && h.kind === "file" ? fsStorage.register(h) : null;
}

// ---- fallback mode: upload into IndexedDB, download results ----
// Layout: /browser/<folder>/...  the translatable files of an uploaded folder (+ .mumain-translator/)
//         /uploads/<name>        other uploaded files (TSV, glossary)
//         /downloads/<name>      files written for download (export, glossary); kept so they can be reopened

const safeName = (n: string) => n.replace(/[/\\]/g, "_") || "file";
const isDownload = (p: string) => storage.resolve(p).startsWith("/downloads/");

async function upload(kind: PickKind): Promise<string | null> {
  if (kind === "folder") {
    const up = await uploadFolder(isTranslatableUpload);
    if (!up) return null;
    const root = `/browser/${safeName(up.root)}`;
    if (!up.files.length) throw new AppError("nothing-to-translate", `Nothing to translate in ${up.root}.`, { path: root });
    // Replace the earlier copy of this folder (files deleted since are gone too), keeping its side data.
    for (const old of await idb!.filesBelow(root)) if (!old.includes("/.mumain-translator/")) await idb!.remove(old);
    for (const f of up.files) await idb!.writeAtomic(`/browser/${f.path.split("/").map(safeName).join("/")}`, f.bytes);
    return root;
  }
  const f = await uploadFile(kind === "tsv" ? ".tsv,.csv,.txt,.zip" : ".tsv,.csv,.txt");
  if (!f) return null;
  const p = `/uploads/${safeName(f.name)}`;
  await idb!.writeAtomic(p, f.bytes);
  return p;
}

async function download(p: string) {
  downloadFile(storage.basename(p), await storage.read(p));
}

// The files a save wrote (relative to the workspace root): one as it is, several as a zip laid out
// like the folder, to unpack over it.
async function downloadSaved(root: string, files: string[], locale: string) {
  const read = (f: string) => storage.read(storage.join(root, f));
  if (files.length === 1) return downloadFile(storage.basename(files[0]!), await read(files[0]!));
  const entries = await Promise.all(files.map(async (f) => ({ name: f, bytes: await read(f) })));
  downloadFile(`${storage.basename(root)}-${locale}.zip`, zip(entries));
}

const state = (): StateResponse => ({ open: session.open, version: __APP_VERSION__ });

export const backend: Backend = {
  kind: "local",
  fallback: !hasFsAccess,
  state: () => call(state),
  rows: () => call(() => session.rows()),
  scan: (path) => call(() => session.scan(path)),
  open: (path, locale, reference, opts = {}) =>
    call(async () => {
      await session.openFolder(path, locale, reference, opts);
      return state();
    }),
  reference: (locale) =>
    call(async () => {
      await session.setReference(locale);
      return state();
    }),
  registration: () => call(() => session.registration()),
  pick: (_lang, kind = "folder") => call(async () => ({ path: await pick(kind) })),
  pickSave: (_lang, kind, defaultName) => call(async () => ({ path: await pickSave(kind, defaultName) })),
  edit: (group, key, value, translator) => call(() => session.edit(group, key, value, translator)),
  keep: (group, key, keep, translator) => call(() => session.setKeep(group, key, keep, translator)),
  revert: (group, key) => call(() => session.revert(group, key)),
  status: (keys, status, translator) => call(() => session.setStatus(keys, status, translator)),
  note: (group, key, note, translator) => call(() => session.setNote(group, key, note, translator)),
  undo: () => call(() => session.undo()),
  redo: () => call(() => session.redo()),
  save: (opts = {}) =>
    call(async () => {
      const r = await session.save(opts);
      const open = session.open;
      if (!hasFsAccess && open && r.files.length) await downloadSaved(open.folder.path, r.files, open.locale);
      return { ...r, status: session.status() };
    }),
  rebase: () => call(() => session.rebase()),
  restoreDraft: () => call(() => session.restoreDraft()),
  discardDraft: () =>
    call(async () => {
      await session.discardDraft();
      return { ok: true as const };
    }),
  exportTsv: (path, keys) =>
    call(async () => {
      const r = await session.exportTsv(path, keys);
      if (!hasFsAccess && isDownload(r.path)) await download(r.path);
      return r;
    }),
  proposals: () => call(() => session.proposals()),
  decideProposals: (decisions, translator) => call(() => session.decideProposals(decisions, translator)),
  importPreview: (path) => call(() => session.previewImport(path)),
  exportPackage: (path, glossary, translator) =>
    call(async () => {
      const r = await session.exportPackage(path, { glossary, translator, tool: __APP_VERSION__ });
      if (!hasFsAccess && isDownload(r.path)) await download(r.path);
      return r;
    }),
  exportSheets: (path) =>
    call(async () => {
      const r = await session.exportSheets(path);
      if (!hasFsAccess && isDownload(r.path)) await download(r.path);
      return r;
    }),
  packageGlossary: (path, token) => call(async () => ({ path: await session.importPackageGlossary(path, token) })),
  importApply: (path, token, take, translator) => call(() => session.applyImport(path, token, take, translator)),
  glossaryLoad: (path) => call(() => loadGlossaryFile(storage, path)),
  glossarySave: (path, entries) =>
    call(async () => {
      const g = await saveGlossaryFile(storage, path, entries);
      if (!hasFsAccess && isDownload(g.path)) await download(g.path);
      return g;
    }),
};
