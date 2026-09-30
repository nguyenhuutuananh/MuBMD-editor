// types.ts - What the Session needs from one group of translatable texts, whatever file format it
// comes from. Two sources:
//   resx    MuMain/src/Localization/<Group>.<locale>.resx: one group per <Group> (Game, Dialog...),
//           keys = the resx keys, English = the en file, the translation = the <locale> file
//   items   Data/Items/GroupNN_<Name>.json: one group per file ("Items.Sword"...), keys = the item
//           numbers, English = name.en, the translation = name.<locale> in the same file
// A group owns exactly one target file (created on the first save for a new resx locale). The
// Session works per key (undo, draft, status, merge) and asks the group to write its file.

import type { Issue, LocaleProgress, Severity, ValueIssue } from "../../core";
import type { RowIssue } from "../../shared/api";

export type SourceKind = "resx" | "items";

// The state of one key in the translation: absent (null), or its text + a comment. The comment is
// the resx <comment> (legacy_id and the "keep" mark); items have none (null).
export type EntryState = { value: string; comment: string | null } | null;

export interface GroupReport {
  byKey: Map<string, RowIssue[]>;
  loose: Issue[]; // issues not tied to a key (a missing en file, <data> without a name)
  progress: LocaleProgress;
  counts: Record<Severity, number>;
}

export interface KeyMeta {
  legacyIds: number[];
  enLine: number; // 0 = unknown
  line: number; // line in the target file, 0 = not there
}

export interface WritePlan {
  file: string; // shown to the user: relative to the workspace root
  path: string;
  text: string;
  created: boolean; // the file does not exist yet
}

export interface SourceGroup {
  readonly source: SourceKind;
  readonly name: string; // unique in the workspace: "Game", "Items.Sword"
  readonly enFile: string | null; // display names, relative to the workspace root
  readonly targetFile: string | null; // null: not created yet (resx)
  readonly referenceFile: string | null;
  readonly itemType: number | null; // items: the "group" of the file (0 = swords...); resx: null

  keys(): string[]; // en order, then keys only the translation has
  en(key: string): string | null; // null: not a key of the English source
  reference(key: string): string | null;
  // Show another locale as the reference (null = none); only reads that locale's file.
  setReference(locale: string | null): Promise<void>;
  current(key: string): EntryState;
  saved(key: string): EntryState;
  apply(key: string, state: EntryState): void; // in memory

  // The entry for a new text typed for `key` (keeps a resx comment / legacy_id).
  entryFor(key: string, cur: EntryState, text: string): EntryState;
  // "Keep English" (resx only); throws not-editable where unsupported.
  keepEntry(key: string, cur: EntryState, keep: boolean): EntryState;
  readonly canKeep: boolean;
  isKeep(state: EntryState): boolean;
  // Throws for a text this file cannot hold (resx: invalid XML characters; items: "||"...).
  validateText(key: string, text: string): void;
  // Checks of one text against its English (import preview).
  check(en: string, text: string): ValueIssue[];

  meta(key: string): KeyMeta;
  report(): GroupReport;

  // Identity of the saved translations: when it differs from the project file, the translations
  // were changed from outside and the merge bases are reset.
  baseHash(): string;
  // The target file on disk differs from what was read (someone else wrote it).
  diskChanged(): Promise<boolean>;
  // The new file text with the texts of `keys` changed, verified to read back as intended.
  planWrite(keys: string[]): WritePlan;
  // After the file was written: the current state becomes the saved one.
  committed(plan: WritePlan): void;
}
