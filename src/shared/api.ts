// api.ts - Types shared by the server (src/server) and the UI (web/).
// Types + plain constants only; nothing imported from node/bun.

import type { ErrorCode, ErrorParams } from "../core/errors";
import type { MergeCounts, MergeItem } from "../core/merge";
import type { NameEncoding, NameIssue, NameIssueCode } from "../core/nameCodec";
import type { Status, TsvProblem } from "../core/tsv";

export type { ErrorCode, ErrorParams, MergeCounts, MergeItem, NameEncoding, NameIssue, NameIssueCode, Status, TsvProblem };
export { STATUSES } from "../core/tsv";

export const LANGS = ["en", "vi"] as const;
export type Lang = (typeof LANGS)[number];
export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

export interface FileInfo {
  path: string;
  fileName: string;
  size: number;
  checksumValid: boolean;
  namedCount: number;
  loadedAt: string; // ISO
}

export interface StateResponse {
  file: FileInfo | null;
  version: string;
}

// One slot, sent as a tuple to keep 8192 rows compact:
// [slot, text, encoding, byteLength, issueCodes]
export type ItemTuple = [number, string, NameEncoding, number, NameIssueCode[]];

// Per-slot translation state, persisted in <Item.bmd>.mubmd/project.json.
export interface SlotRecord {
  status: Status;
  note: string;
  translator: string; // who last changed the name / status / note
  updatedAt: string; // ISO, "" if never
  // Merge base: the name before this copy first changed it (exported as BaseName so the
  // receiver can tell "only they changed it" from a real conflict). Reset when the file is replaced.
  origin?: string;
}

export const DEFAULT_RECORD: SlotRecord = { status: "untranslated", note: "", translator: "", updatedAt: "" };

// A slot whose NAME differs from the file on disk (unsaved).
export interface EditInfo {
  slot: number;
  originalText: string;
  originalEncoding: NameEncoding;
  translator: string;
  at: string;
}

export interface DocStatus {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

// Auto-saved draft from a previous session that was never saved to Item.bmd.
export interface DraftInfo {
  count: number;
  savedAt: string;
  translators: string[];
  baseMatches: boolean; // the file on disk is still the one the draft was made from
}

export interface ItemsResponse {
  file: FileInfo;
  items: ItemTuple[]; // always all MAX_ITEM slots, in slot order
  edits: EditInfo[];
  records: [number, SlotRecord][]; // only slots with a non-default record
  dirty: number[]; // slots with unsaved changes (name and/or record)
  status: DocStatus;
  draft: DraftInfo | null;
  rebased: boolean; // the file was replaced from outside since the last save; merge bases were reset
}

export interface SlotState {
  item: ItemTuple;
  edit: EditInfo | null; // null = name matches the file on disk
  record: SlotRecord;
  dirty: boolean;
}

// Result of edit / revert / status / note / import / undo / redo / draft restore.
export interface MutationResponse {
  changed: SlotState[];
  status: DocStatus;
}

export interface OpenRequest {
  path: string;
  discard?: boolean; // discard unsaved edits of the currently open file
}

export interface EditRequest {
  slot: number;
  name: string;
  translator: string;
}

export interface RevertRequest {
  slot: number;
  translator: string;
}

export interface StatusRequest {
  slots: number[];
  status: Status;
  translator: string;
}

export interface NoteRequest {
  slot: number;
  note: string;
  translator: string;
}

// Reference names shown next to each slot (e.g. the original English / Japanese names).
export interface ReferenceRequest {
  path: string | null; // null = clear
}

export interface ReferenceInfo {
  path: string;
  fileName: string;
  entries: [number, string][]; // [slot, name], only non-empty names
}

export interface ExportRequest {
  path: string;
  slots: number[];
}

export interface ExportResponse {
  path: string;
  count: number;
}

export interface ImportPreviewRequest {
  path: string;
}

export interface ImportPreview {
  path: string;
  fileName: string;
  token: string; // SHA-1 of the file; apply refuses if the file changed since the preview
  items: MergeItem[];
  counts: MergeCounts;
  problems: TsvProblem[];
  hasBase: boolean;
}

export interface ImportApplyRequest {
  path: string;
  token: string;
  take: number[]; // slots to take from the file
  translator: string;
}

export interface SaveRequest {
  path?: string; // save to a different file
  force?: boolean; // overwrite even though the file on disk changed
}

export interface SaveResponse {
  file: FileInfo;
  savedCount: number;
  backupPath: string | null;
  logPath: string;
  status: DocStatus;
}

export type PickKind = "bmd" | "tsv" | "reference";

export interface PickRequest {
  lang?: Lang; // language of the native OS dialog captions
  kind?: PickKind; // file type filter (default "bmd")
}

export interface PickSaveRequest {
  lang?: Lang;
  kind?: "bmd" | "tsv";
  defaultName?: string; // file name suggestion (folder = the open file's folder)
}

export interface PickResponse {
  path: string | null; // null = the user cancelled
}

// `error` is an English sentence (logs / fallback); the UI translates `code` + `params`.
export interface ErrorResponse {
  error: string;
  code: ErrorCode;
  params: ErrorParams;
  issues?: NameIssue[];
}
