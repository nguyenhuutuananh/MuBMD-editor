// api.ts - Types shared by the server (src/server) and the UI (web/).
// Types + plain constants only; nothing imported from node/bun.

import type { ErrorCode, ErrorParams } from "../core/errors";
import type { GlossaryEntry } from "../core/glossary";
import type { MergeCounts, MergeItem } from "../core/merge";
import type { NameIssue, NameIssueCode } from "../core/nameCodec";
import type { Status, TsvProblem } from "../core/tsv";
import type { ItemsLayout } from "../session/itemsFolder";

export type { ErrorCode, ErrorParams, GlossaryEntry, ItemsLayout, MergeCounts, MergeItem, NameIssue, NameIssueCode, Status, TsvProblem };
export { STATUSES } from "../core/tsv";

export const LANGS = ["en", "vi"] as const;
export type Lang = (typeof LANGS)[number];
export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

// The open item data folder (Data/Items of a game folder).
export interface FileInfo {
  path: string; // the item data folder (identity of the open document)
  root: string; // the folder the user picked (game folder)
  layout: ItemsLayout; // where in `root` the item folder was found
  fileName: string; // short display name: the item folder relative to `root`, e.g. "Data/Items"
  locale: string; // the language being translated, e.g. "vi"
  fileCount: number; // item files (Group00_Sword.json ...)
  itemCount: number;
  translatedCount: number; // items with a name in `locale` (in the files on disk)
  loadedAt: string; // ISO
}

export interface StateResponse {
  file: FileInfo | null;
  version: string;
}

// One slot, sent as a tuple to keep 8192 rows compact:
// [slot, name ("" = not translated), English name (null = no item in this slot), length, issueCodes]
export type ItemTuple = [number, string, string | null, number, NameIssueCode[]];

// Per-slot translation state, persisted in <Data/Items>.mubmd/project.json.
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
  originalText: string; // "" = was not translated
  translator: string;
  at: string;
}

export interface DocStatus {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

// Auto-saved draft from a previous session that was never saved to the item files.
export interface DraftInfo {
  count: number;
  savedAt: string;
  translators: string[];
  baseMatches: boolean; // the names on disk are still the ones the draft was made from
}

export interface ItemsResponse {
  file: FileInfo;
  items: ItemTuple[]; // always all MAX_ITEM slots, in slot order
  edits: EditInfo[];
  records: [number, SlotRecord][]; // only slots with a non-default record
  dirty: number[]; // slots with unsaved changes (name and/or record)
  status: DocStatus;
  draft: DraftInfo | null;
  rebased: boolean; // the names were changed from outside since the last save; merge bases were reset
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
  path: string; // the game folder (or Data/Items itself)
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

// Reference names from a TSV / CSV file, shown next to each slot (e.g. the Japanese originals).
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

// "tsv" = a translation file, "game" = another game folder to compare with (no merge base).
export type ImportSource = "tsv" | "game";

export interface ImportPreviewRequest {
  path: string;
  source?: ImportSource;
}

export interface ImportPreview {
  path: string;
  fileName: string;
  source: ImportSource;
  token: string; // SHA-1 of the file; apply refuses if the file changed since the preview
  items: MergeItem[];
  counts: MergeCounts;
  problems: TsvProblem[];
  hasBase: boolean;
}

export interface ImportApplyRequest {
  path: string;
  source?: ImportSource;
  token: string;
  take: number[]; // slots to take from the file
  translator: string;
}

export interface SaveRequest {
  force?: boolean; // overwrite even though a file on disk changed
}

export interface SaveResponse {
  file: FileInfo;
  savedCount: number;
  written: string[]; // item files that were rewritten
  backupDir: string | null; // where their previous versions were copied (null = nothing rewritten)
  logPath: string;
  status: DocStatus;
}

export interface GlossaryInfo {
  path: string;
  fileName: string;
  format: "tsv" | "legacy-csv"; // legacy CSV is read-only: saving writes a TSV
  entries: GlossaryEntry[];
}

// "game" = the game folder to open, "compare" = another game folder (both folder dialogs); the rest
// are file dialogs.
export type PickKind = "game" | "tsv" | "reference" | "glossary" | "compare";
export const FOLDER_KINDS: readonly PickKind[] = ["game", "compare"];

export interface PickRequest {
  lang?: Lang; // language of the native OS dialog captions
  kind?: PickKind; // what to choose (default "game")
}

export type SaveKind = "tsv" | "glossary";

export interface PickSaveRequest {
  lang?: Lang;
  kind?: SaveKind;
  defaultName?: string; // file name suggestion (folder = the open game folder)
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
