// httpBackend.ts - Desktop build: calls the local Bun server (src/server/app.ts) over HTTP.

import type {
  DecideResponse,
  ErrorResponse,
  ExportPackageResponse,
  ExportSheetsResponse,
  ExportResponse,
  WorkspaceListing,
  GlossaryInfo,
  ImportPreview,
  MutationResponse,
  PickResponse,
  ProposalsResponse,
  RebaseResponse,
  RegistrationInfo,
  RowsResponse,
  SaveResponse,
  StateResponse,
} from "../../../src/shared/api";
import { ApiError, type Backend } from "./backend";

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiError("Lost connection to MuMain-translator.", 0, "offline");
  }
  const data = (await res.json().catch(() => null)) as T | ErrorResponse | null;
  if (!res.ok || data === null) {
    const err = data as ErrorResponse | null;
    if (!err?.code) throw new ApiError(`Server error (${res.status})`, res.status, "bad-response", { status: res.status });
    throw new ApiError(err.error, res.status, err.code, err.params ?? {});
  }
  return data as T;
}

export const backend: Backend = {
  kind: "http",
  state: () => request<StateResponse>("/api/state"),
  rows: () => request<RowsResponse>("/api/rows"),
  scan: (path) => request<WorkspaceListing>("/api/scan", { path }),
  open: (path, locale, reference, discard = false, create = false) => request<StateResponse>("/api/open", { path, locale, reference, discard, create }),
  registration: () => request<RegistrationInfo>("/api/registration"),
  reference: (locale) => request<StateResponse>("/api/reference", { locale }),
  pick: (lang, kind = "folder") => request<PickResponse>("/api/pick", { lang, kind }),
  pickSave: (lang, kind, defaultName) => request<PickResponse>("/api/pick-save", { lang, kind, defaultName }),
  status: (keys, status, translator) => request<MutationResponse>("/api/status", { keys, status, translator }),
  note: (group, key, note, translator) => request<MutationResponse>("/api/note", { group, key, note, translator }),
  exportTsv: (path, keys) => request<ExportResponse>("/api/export", { path, keys }),
  importPreview: (path) => request<ImportPreview>("/api/import/preview", { path }),
  exportPackage: (path, glossary, translator) => request<ExportPackageResponse>("/api/package/export", { path, glossary, translator }),
  exportSheets: (path) => request<ExportSheetsResponse>("/api/sheets/export", { path }),
  packageGlossary: (path, token) => request<{ path: string }>("/api/package/glossary", { path, token }),
  importApply: (path, token, take, translator) => request<MutationResponse>("/api/import/apply", { path, token, take, translator }),
  glossaryLoad: (path) => request<GlossaryInfo>("/api/glossary/load", { path }),
  glossarySave: (path, entries) => request<GlossaryInfo>("/api/glossary/save", { path, entries }),
  edit: (group, key, value, translator) => request<MutationResponse>("/api/edit", { group, key, value, translator }),
  keep: (group, key, keep, translator) => request<MutationResponse>("/api/keep", { group, key, keep, translator }),
  revert: (group, key) => request<MutationResponse>("/api/revert", { group, key }),
  undo: () => request<MutationResponse>("/api/undo", {}),
  redo: () => request<MutationResponse>("/api/redo", {}),
  save: (opts = {}) => request<SaveResponse>("/api/save", opts),
  rebase: () => request<RebaseResponse>("/api/rebase", {}),
  restoreDraft: () => request<MutationResponse & { skipped: number }>("/api/draft/restore", {}),
  discardDraft: () => request<{ ok: true }>("/api/draft/discard", {}),
  proposals: () => request<ProposalsResponse>("/api/proposals"),
  decideProposals: (decisions, translator) => request<DecideResponse>("/api/proposals/decide", { decisions, translator }),
};
