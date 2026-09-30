// httpBackend.ts - Desktop build: calls the local Bun server (src/server/app.ts) over HTTP.

import type {
  ErrorResponse,
  ExportResponse,
  GlossaryInfo,
  ImportPreview,
  ItemsResponse,
  MutationResponse,
  PickResponse,
  ReferenceInfo,
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
    throw new ApiError("Lost connection to MuBMD-editor.", 0, "offline");
  }
  const data = (await res.json().catch(() => null)) as T | ErrorResponse | null;
  if (!res.ok || data === null) {
    const err = data as ErrorResponse | null;
    if (!err?.code) throw new ApiError(`Server error (${res.status})`, res.status, "bad-response", { status: res.status });
    throw new ApiError(err.error, res.status, err.code, err.params ?? {}, err.issues);
  }
  return data as T;
}

export const backend: Backend = {
  kind: "http",
  state: () => request<StateResponse>("/api/state"),
  items: () => request<ItemsResponse>("/api/items"),
  open: (path, discard = false) => request<StateResponse>("/api/open", { path, discard }),
  pick: (lang, kind = "game") => request<PickResponse>("/api/pick", { lang, kind }),
  pickSave: (lang, kind = "tsv", defaultName) => request<PickResponse>("/api/pick-save", { lang, kind, defaultName }),
  edit: (slot, name, translator) => request<MutationResponse>("/api/edit", { slot, name, translator }),
  revert: (slot, translator) => request<MutationResponse>("/api/revert", { slot, translator }),
  status: (slots, status, translator) => request<MutationResponse>("/api/status", { slots, status, translator }),
  note: (slot, note, translator) => request<MutationResponse>("/api/note", { slot, note, translator }),
  reference: (path) => request<{ reference: ReferenceInfo | null }>("/api/reference", { path }),
  exportTsv: (path, slots) => request<ExportResponse>("/api/export", { path, slots }),
  importPreview: (path, source = "tsv") => request<ImportPreview>("/api/import/preview", { path, source }),
  importApply: (path, token, take, translator, source = "tsv") =>
    request<MutationResponse>("/api/import/apply", { path, token, take, translator, source }),
  glossaryLoad: (path) => request<GlossaryInfo>("/api/glossary/load", { path }),
  glossarySave: (path, entries) => request<GlossaryInfo>("/api/glossary/save", { path, entries }),
  undo: () => request<MutationResponse>("/api/undo", {}),
  redo: () => request<MutationResponse>("/api/redo", {}),
  restoreDraft: () => request<MutationResponse & { skipped: number }>("/api/draft/restore", {}),
  discardDraft: () => request<{ ok: true }>("/api/draft/discard", {}),
  save: (opts = {}) => request<SaveResponse>("/api/save", opts),
};
