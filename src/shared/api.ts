// api.ts - Types shared by the server (src/server) and the UI (web/).
// Types + plain constants only; nothing imported from node/bun.

import type { ErrorCode, ErrorParams } from "../core/errors";
import type { NameEncoding, NameIssue, NameIssueCode } from "../core/nameCodec";

export type { ErrorCode, ErrorParams, NameEncoding, NameIssue, NameIssueCode };

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

// Who last edited this slot, and when (for merging several translators' work later).
export interface EditMeta {
  translator: string;
  at: string; // ISO
}

// A slot that differs from the original file (unsaved).
export interface EditInfo extends EditMeta {
  slot: number;
  originalText: string;
  originalEncoding: NameEncoding;
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
  status: DocStatus;
  draft: DraftInfo | null;
}

export interface SlotState {
  item: ItemTuple;
  edit: EditInfo | null; // null = slot matches the original file
}

// Result of edit / revert / undo / redo / draft restore.
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

export interface PickRequest {
  lang?: Lang; // language of the native OS dialog captions
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
