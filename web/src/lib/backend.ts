// backend.ts - What the UI needs from "the thing that edits files". Two implementations, chosen at
// build time through the "@backend" alias (vite.config.ts):
//   httpBackend.ts   desktop build: calls the local Bun server over HTTP
//   localBackend.ts  web build: runs the Session right here in the browser
// Errors are always ApiError with a code + params for the UI to translate.

import type {
  ErrorCode,
  ErrorParams,
  ExportResponse,
  GlossaryEntry,
  GlossaryInfo,
  ImportPreview,
  ImportSource,
  ItemsResponse,
  Lang,
  MutationResponse,
  NameIssue,
  PickKind,
  PickResponse,
  ReferenceInfo,
  SaveKind,
  SaveRequest,
  SaveResponse,
  StateResponse,
  Status,
} from "../../../src/shared/api";

// Client-side error codes (not sent by the server).
export type ClientErrorCode = "offline" | "bad-response" | "fs-unsupported";

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

export interface Backend {
  readonly kind: "http" | "local";
  // Web build without the File System Access API: files are uploaded, results downloaded.
  readonly fallback?: boolean;
  state(): Promise<StateResponse>;
  items(): Promise<ItemsResponse>;
  open(path: string, discard?: boolean): Promise<StateResponse>;
  pick(lang: Lang, kind?: PickKind): Promise<PickResponse>;
  pickSave(lang: Lang, kind?: SaveKind, defaultName?: string): Promise<PickResponse>;
  edit(slot: number, name: string, translator: string): Promise<MutationResponse>;
  revert(slot: number, translator: string): Promise<MutationResponse>;
  status(slots: number[], status: Status, translator: string): Promise<MutationResponse>;
  note(slot: number, note: string, translator: string): Promise<MutationResponse>;
  reference(path: string | null): Promise<{ reference: ReferenceInfo | null }>;
  exportTsv(path: string, slots: number[]): Promise<ExportResponse>;
  importPreview(path: string, source?: ImportSource): Promise<ImportPreview>;
  importApply(path: string, token: string, take: number[], translator: string, source?: ImportSource): Promise<MutationResponse>;
  glossaryLoad(path: string): Promise<GlossaryInfo>;
  glossarySave(path: string, entries: GlossaryEntry[]): Promise<GlossaryInfo>;
  undo(): Promise<MutationResponse>;
  redo(): Promise<MutationResponse>;
  restoreDraft(): Promise<MutationResponse & { skipped: number }>;
  discardDraft(): Promise<{ ok: true }>;
  save(opts?: SaveRequest): Promise<SaveResponse>;
}
