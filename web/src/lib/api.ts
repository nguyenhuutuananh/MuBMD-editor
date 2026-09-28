// api.ts - Calls the local server API. Errors carry a code + params for the UI to translate.

import type {
  ErrorCode,
  ErrorParams,
  ErrorResponse,
  ItemsResponse,
  Lang,
  MutationResponse,
  NameIssue,
  PickResponse,
  SaveRequest,
  SaveResponse,
  StateResponse,
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
  pick: (lang: Lang) => request<PickResponse>("/api/pick", { lang }),
  pickSave: (lang: Lang) => request<PickResponse>("/api/pick-save", { lang }),
  edit: (slot: number, name: string, translator: string) =>
    request<MutationResponse>("/api/edit", { slot, name, translator }),
  revert: (slot: number, translator: string) => request<MutationResponse>("/api/revert", { slot, translator }),
  undo: () => request<MutationResponse>("/api/undo", {}),
  redo: () => request<MutationResponse>("/api/redo", {}),
  restoreDraft: () => request<MutationResponse & { skipped: number }>("/api/draft/restore", {}),
  discardDraft: () => request<{ ok: true }>("/api/draft/discard", {}),
  save: (opts: SaveRequest = {}) => request<SaveResponse>("/api/save", opts),
};
