// backend.ts - What the UI needs from "the thing that reads the files". Chosen at build time
// through the "@backend" alias (vite.config.ts):
//   httpBackend.ts   desktop build: calls the local Bun server over HTTP
//   localBackend.ts  web build: runs the Session right here in the browser
// Errors are always ApiError with a code + params for the UI to translate.

import type {
  DecideResponse,
  ErrorCode,
  ExportPackageResponse,
  ExportSheetsResponse,
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
  SaveKind,
  Status,
  MutationResponse,
  PickResponse,
  ProposalDecision,
  ProposalsResponse,
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

export interface OpenOptions {
  discard?: boolean; // discard the unsaved edits of the folder open now
  create?: boolean; // a locale without files yet
  name?: string; // display name of the locale, stored for this folder
}

export interface Backend {
  readonly kind: "http" | "local";
  // Web build without the File System Access API: files are uploaded, results downloaded.
  readonly fallback?: boolean;
  state(): Promise<StateResponse>;
  rows(): Promise<RowsResponse>;
  scan(path: string): Promise<WorkspaceListing>;
  open(path: string, locale: string, reference: string | null, opts?: OpenOptions): Promise<StateResponse>;
  registration(): Promise<RegistrationInfo>;
  reference(locale: string | null): Promise<StateResponse>;
  pick(lang: Lang, kind?: PickKind): Promise<PickResponse>;
  pickSave(lang: Lang, kind: SaveKind, defaultName?: string): Promise<PickResponse>;
  status(keys: KeyRef[], status: Status, translator: string): Promise<MutationResponse>;
  note(group: string, key: string, note: string, translator: string): Promise<MutationResponse>;
  exportTsv(path: string, keys: KeyRef[]): Promise<ExportResponse>;
  importPreview(path: string): Promise<ImportPreview>; // a TSV / CSV, or a translation package (.zip)
  exportPackage(path: string, glossary: string | null, translator: string): Promise<ExportPackageResponse>;
  packageGlossary(path: string, token: string): Promise<{ path: string }>;
  exportSheets(path: string): Promise<ExportSheetsResponse>; // a ZIP of one CSV per Google Sheets tab // the glossary of a previewed package, written to the side data
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
  proposals(): Promise<ProposalsResponse>;
  decideProposals(decisions: ProposalDecision[], translator: string): Promise<DecideResponse>;
}
