// backend.ts - What the UI needs from "the thing that reads the files". Chosen at build time
// through the "@backend" alias (vite.config.ts):
//   httpBackend.ts   desktop build: calls the local Bun server over HTTP
//   localBackend.ts  web build: runs the Session right here in the browser
// Errors are always ApiError with a code + params for the UI to translate.

import type {
  ErrorCode,
  ErrorParams,
  ExportResponse,
  WorkspaceListing,
  GlossaryEntry,
  GlossaryInfo,
  ImportPreview,
  KeyRef,
  Lang,
  PickKind,
  RegistrationInfo,
  Status,
  MutationResponse,
  PickResponse,
  RebaseResponse,
  RowsResponse,
  SaveRequest,
  SaveResponse,
  StateResponse,
} from "../../../src/shared/api";

// Client-side error codes (not sent by the server).
export type ClientErrorCode = "offline" | "bad-response" | "fs-unsupported";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode | ClientErrorCode,
    readonly params: ErrorParams = {},
  ) {
    super(message);
  }
}

export interface Backend {
  readonly kind: "http" | "local";
  // Web build without the File System Access API: files are uploaded, results downloaded.
  readonly fallback?: boolean;
  state(): Promise<StateResponse>;
  rows(): Promise<RowsResponse>;
  scan(path: string): Promise<WorkspaceListing>;
  open(path: string, locale: string, reference: string | null, discard?: boolean, create?: boolean): Promise<StateResponse>;
  registration(): Promise<RegistrationInfo>;
  reference(locale: string | null): Promise<StateResponse>;
  pick(lang: Lang, kind?: PickKind): Promise<PickResponse>;
  pickSave(lang: Lang, kind: "tsv" | "glossary", defaultName?: string): Promise<PickResponse>;
  status(keys: KeyRef[], status: Status, translator: string): Promise<MutationResponse>;
  note(group: string, key: string, note: string, translator: string): Promise<MutationResponse>;
  exportTsv(path: string, keys: KeyRef[]): Promise<ExportResponse>;
  importPreview(path: string): Promise<ImportPreview>;
  importApply(path: string, token: string, take: KeyRef[], translator: string): Promise<MutationResponse>;
  glossaryLoad(path: string): Promise<GlossaryInfo>;
  glossarySave(path: string, entries: GlossaryEntry[]): Promise<GlossaryInfo>;
  edit(group: string, key: string, value: string | null, translator: string): Promise<MutationResponse>;
  keep(group: string, key: string, keep: boolean, translator: string): Promise<MutationResponse>;
  revert(group: string, key: string): Promise<MutationResponse>;
  undo(): Promise<MutationResponse>;
  redo(): Promise<MutationResponse>;
  save(opts?: SaveRequest): Promise<SaveResponse>;
  rebase(): Promise<RebaseResponse>;
  restoreDraft(): Promise<MutationResponse & { skipped: number }>;
  discardDraft(): Promise<{ ok: true }>;
}
