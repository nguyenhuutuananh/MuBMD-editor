// api.ts - Gọi API của server cục bộ.

import type {
  ErrorCode,
  ErrorResponse,
  ItemsResponse,
  MutationResponse,
  PickResponse,
  SaveRequest,
  SaveResponse,
  StateResponse,
} from "../src/shared/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ErrorCode,
    readonly issues?: ErrorResponse["issues"],
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
    throw new ApiError("Mất kết nối tới MuBMD-editor. Cửa sổ dòng lệnh của công cụ còn đang chạy không?", 0);
  }
  const data = (await res.json().catch(() => ({ error: `Lỗi máy chủ (${res.status})` }))) as T | ErrorResponse;
  if (!res.ok) {
    const err = data as ErrorResponse;
    throw new ApiError(err.error ?? `Lỗi ${res.status}`, res.status, err.code, err.issues);
  }
  return data as T;
}

export const api = {
  state: () => request<StateResponse>("/api/state"),
  items: () => request<ItemsResponse>("/api/items"),
  open: (path: string, discard = false) => request<StateResponse>("/api/open", { path, discard }),
  pick: () => request<PickResponse>("/api/pick", {}),
  pickSave: () => request<PickResponse>("/api/pick-save", {}),
  edit: (slot: number, name: string, translator: string) =>
    request<MutationResponse>("/api/edit", { slot, name, translator }),
  revert: (slot: number, translator: string) => request<MutationResponse>("/api/revert", { slot, translator }),
  undo: () => request<MutationResponse>("/api/undo", {}),
  redo: () => request<MutationResponse>("/api/redo", {}),
  restoreDraft: () => request<MutationResponse & { skipped: number }>("/api/draft/restore", {}),
  discardDraft: () => request<{ ok: true }>("/api/draft/discard", {}),
  save: (opts: SaveRequest = {}) => request<SaveResponse>("/api/save", opts),
};
