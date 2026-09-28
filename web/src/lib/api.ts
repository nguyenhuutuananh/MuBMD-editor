// api.ts - Calls the local server API. Errors carry a code + params for the UI to translate.

import type {
  ErrorCode,
  ErrorParams,
  ErrorResponse,
  ExportResponse,
  GlossaryEntry,
  GlossaryInfo,
  ImportPreview,
  ItemsResponse,
  Lang,
  MutationResponse,
  NameIssue,
  PickKind,
  PickResponse,
  ReferenceInfo,
  SaveRequest,
  SaveResponse,
  StateResponse,
  Status,
} from "../../../src/shared/api";

// Client-side error codes (not sent by the server).
export type ClientErrorCode = "offline" | "bad-response";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode | ClientErrorCode,
    readonly params: ErrorParams = {},
    readonly issues?: NameIssue[],
  ) {
    super(message);
  }
}

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

export const api = {
  state: () => request<StateResponse>("/api/state"),
  items: () => request<ItemsResponse>("/api/items"),
  open: (path: string, discard = false) => request<StateResponse>("/api/open", { path, discard }),
  pick: (lang: Lang, kind: PickKind = "bmd") => request<PickResponse>("/api/pick", { lang, kind }),
  pickSave: (lang: Lang, kind: "bmd" | "tsv" | "glossary" = "bmd", defaultName?: string) =>
    request<PickResponse>("/api/pick-save", { lang, kind, defaultName }),
  edit: (slot: number, name: string, translator: string) =>
    request<MutationResponse>("/api/edit", { slot, name, translator }),
  revert: (slot: number, translator: string) => request<MutationResponse>("/api/revert", { slot, translator }),
  status: (slots: number[], status: Status, translator: string) =>
    request<MutationResponse>("/api/status", { slots, status, translator }),
  note: (slot: number, note: string, translator: string) => request<MutationResponse>("/api/note", { slot, note, translator }),
  reference: (path: string | null) => request<{ reference: ReferenceInfo | null }>("/api/reference", { path }),
  exportTsv: (path: string, slots: number[]) => request<ExportResponse>("/api/export", { path, slots }),
  importPreview: (path: string) => request<ImportPreview>("/api/import/preview", { path }),
  importApply: (path: string, token: string, take: number[], translator: string) =>
    request<MutationResponse>("/api/import/apply", { path, token, take, translator }),
  glossaryLoad: (path: string) => request<GlossaryInfo>("/api/glossary/load", { path }),
  glossarySave: (path: string, entries: GlossaryEntry[]) => request<GlossaryInfo>("/api/glossary/save", { path, entries }),
  undo: () => request<MutationResponse>("/api/undo", {}),
  redo: () => request<MutationResponse>("/api/redo", {}),
  restoreDraft: () => request<MutationResponse & { skipped: number }>("/api/draft/restore", {}),
  discardDraft: () => request<{ ok: true }>("/api/draft/discard", {}),
  save: (opts: SaveRequest = {}) => request<SaveResponse>("/api/save", opts),
};
