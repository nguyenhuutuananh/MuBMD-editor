// api.ts - Types shared by the server (src/server) and the UI (web/).
// Types + plain constants only; nothing imported from node/bun.

import type { ErrorCode, ErrorParams } from "../core/errors";
import type { GlossaryEntry } from "../core/glossary";
import type { MergeCounts, MergeItem } from "../core/merge";
import type { Status, TsvProblem } from "../core/tsv";
import type { Issue, IssueCode, IssueParams, LocaleProgress, Severity } from "../core/validate";
import type { ItemsLayout } from "../session/itemsFolder";
import type { SourceKind } from "../session/sources/types";

export type {
  ErrorCode,
  ErrorParams,
  GlossaryEntry,
  Issue,
  IssueCode,
  IssueParams,
  ItemsLayout,
  LocaleProgress,
  MergeCounts,
  MergeItem,
  Severity,
  SourceKind,
  Status,
  TsvProblem,
};
export { STATUSES } from "../core/tsv";

// Per-key translation state, persisted in .mumain-translator/project-<locale>.json (not in the
// translated files).
export interface KeyRecord {
  status: Status;
  note: string;
  translator: string; // who last changed the text / status / note
  updatedAt: string; // ISO, "" if never
  // Merge base: the translation before this copy first changed it (exported as BaseText so the
  // receiver can tell "only they changed it" from a real conflict). Reset when the file changed
  // from outside (git pull, a new master copy).
  origin?: string;
}

// A key of a group: [group name, key]. Item groups are "Items.Sword"... with the item number as key.
export type KeyRef = [string, string];

// Languages of the tool's own UI (not the game's locales).
export const LANGS = ["en", "vi"] as const;
export type Lang = (typeof LANGS)[number];
export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

// A workspace as found on disk (before choosing a locale): the Localization string tables and / or
// the item data (see src/session/workspace.ts).
export interface WorkspaceListing {
  path: string; // the workspace root (where .mumain-translator/ is kept)
  resx: {
    dir: string;
    rel: string; // relative to the root, e.g. "src/Localization" ("" = the root)
    groups: { name: string; locales: string[]; hasDefault: boolean }[];
    skipped: string[]; // files that are not <Group>.<locale>.resx (Game.vi.resx.bak...)
  } | null;
  items: {
    dir: string;
    rel: string; // e.g. "src/bin/Data/Items", "Main.app/Contents/MacOS/Data/Items"
    layout: ItemsLayout;
    files: { file: string; locales: string[] }[]; // locales that have a name in the file
  } | null;
  locales: { code: string; groups: number }[]; // en first; groups = how many groups / item files have it
}

export interface GroupInfo {
  source: SourceKind;
  name: string; // "Game", "Items.Sword"...
  itemType: number | null; // items: the item group (0 = swords ... 15); resx: null
  canKeep: boolean; // "keep English" is possible (resx)
  enFile: string | null; // null: the group has no en file (the build fails); relative to the root
  file: string | null; // target locale file; null = not created yet (every key untranslated)
  referenceFile: string | null;
  progress: LocaleProgress;
  counts: Record<Severity, number>; // issues of the target locale + the en file of this group
  dirty: number; // keys with unsaved changes
}

// Side data of MuResx-editor / MuBMD-editor carried over when the workspace was first opened.
export interface MigrationInfo {
  from: string[];
  records: number;
  draftEdits: number;
}

export interface OpenInfo {
  folder: WorkspaceListing;
  migrated?: MigrationInfo | null; // set by the open that carried the old side data over
  locale: string; // the locale being translated
  reference: string | null; // an extra locale shown next to en
  loadedAt: string; // ISO
}

export interface StateResponse {
  open: OpenInfo | null;
  version: string;
}

// An issue attached to a row: [code, locale of the file it is in (en or the target), params]
// (params omitted when empty).
export type RowIssue = [IssueCode, string, IssueParams?];

export const ROW_DIRTY = 1; // unsaved change
export const ROW_KEEP = 2; // marked "keep" (stays English on purpose)

// One key of one group, sent as a tuple to keep ~3700 rows compact:
// [group index, key, en text (null: extra key), translation (null: missing), reference text,
//  issues, legacy ids, en line, translation line, flags (ROW_*), saved translation (when dirty),
//  status (the record's, else derived from the text), record (null: none)]
export type RowTuple = [
  number,
  string,
  string | null,
  string | null,
  string | null,
  RowIssue[],
  number[],
  number,
  number,
  number,
  string | null,
  Status,
  KeyRecord | null,
];

export interface DocStatus {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

// Unsaved edits of an earlier session (draft-<locale>.json), offered for restore after opening.
export interface DraftInfo {
  count: number;
  savedAt: string;
  translators: string[];
}

export interface RowsResponse {
  open: OpenInfo;
  groups: GroupInfo[];
  rows: RowTuple[]; // group by group, en order, then keys only the translation has
  issues: Issue[]; // issues not tied to a row (missing en file, <data> without a name)
  status: DocStatus;
  draft: DraftInfo | null;
}

// Result of edit / keep / revert / status / note / import / undo / redo / draft restore.
export interface MutationResponse {
  changed: RowTuple[];
  groups: GroupInfo[];
  status: DocStatus;
}

export interface EditRequest {
  group: string;
  key: string;
  value: string | null; // null or "" = remove the translation (the game shows English)
  translator: string;
}

export interface KeepRequest {
  group: string;
  key: string;
  keep: boolean;
  translator: string;
}

export interface RevertRequest {
  group: string;
  key: string;
}

export interface SaveRequest {
  force?: boolean; // overwrite files that changed on disk
}

export interface SaveResponse {
  files: string[]; // file names written
  created: string[]; // of those, new files (e.g. Dialog.vi.resx)
  savedCount: number; // keys
  backups: string[];
  logPath: string;
  status: DocStatus;
}

// Reload from disk keeping the unsaved edits on top of the new files.
export interface RebaseResponse {
  changedFiles: string[]; // files that were different on disk (merge bases of their keys were reset)
  conflicts: { group: string; key: string }[]; // keys changed on disk too (our version kept)
}

export interface ScanRequest {
  path: string;
}

export interface OpenRequest {
  path: string;
  locale: string;
  reference?: string | null;
  discard?: boolean; // discard unsaved edits of the folder open now
  create?: boolean; // a locale the folder has no file for yet (files are created on the first save)
}

// Is the locale selectable in the game (see src/core/registration.ts)? null for a file that is not
// next to the folder (not a MuMain checkout, or the web build, which only sees the folder itself).
export interface RegistrationFile {
  path: string; // relative to the Localization folder
  registered: boolean;
  line: string;
  after: string | null;
}

export interface RegistrationInfo {
  locale: string;
  name: string;
  optionWindow: RegistrationFile | null;
  emitter: RegistrationFile | null;
}

export interface ReferenceRequest {
  locale: string | null; // null = none
}

export type PickKind = "folder" | "tsv" | "glossary";

export interface PickRequest {
  lang?: Lang; // language of the native OS dialog captions
  kind?: PickKind;
}

export interface PickSaveRequest {
  lang?: Lang;
  kind?: "tsv" | "glossary";
  defaultName?: string; // file name suggestion (folder = next to the Localization folder)
}

export interface StatusRequest {
  keys: KeyRef[];
  status: Status;
  translator: string;
}

export interface NoteRequest {
  group: string;
  key: string;
  note: string;
  translator: string;
}

export interface ExportRequest {
  path: string;
  keys: KeyRef[];
}

export interface ExportResponse {
  path: string;
  count: number;
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
  take: KeyRef[];
  translator: string;
}

export interface GlossaryInfo {
  path: string;
  fileName: string;
  format: "tsv" | "legacy-csv"; // legacy CSV is read-only: saving writes a TSV
  entries: GlossaryEntry[];
}

export interface PickResponse {
  path: string | null; // null = the user cancelled
}

// `error` is an English sentence (logs / fallback); the UI translates `code` + `params`.
export interface ErrorResponse {
  error: string;
  code: ErrorCode;
  params: ErrorParams;
}
