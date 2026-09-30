// search.ts - Accent-insensitive search + slot filtering. Pure logic, no DOM.

import { MAX_ITEM_INDEX } from "../../../src/core/format";
import { type GlossaryEntry, checkGlossary, isProblemHint } from "../../../src/core/glossary";
import {
  DEFAULT_RECORD,
  type EditInfo,
  type ItemTuple,
  type NameIssueCode,
  type SlotRecord,
  type SlotState,
  type Status,
} from "../../../src/shared/api";

export const NEAR_LIMIT_CHARS = 40;

// "Kiếm Rồng Đỏ" -> "kiem rong do": strip accents, đ -> d, lowercase.
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

export interface Row {
  slot: number;
  itemType: number;
  itemIndex: number;
  text: string; // name in the target language, "" = not translated
  english: string | null; // null = no item in this slot
  folded: string; // name + English + reference, folded for search
  length: number; // characters, as the game counts them
  issues: NameIssueCode[];
  edit: EditInfo | null; // name differs from the file on disk (unsaved)
  record: SlotRecord;
  dirty: boolean; // unsaved change of any kind (name, status, note)
  reference: string; // name from the reference file, "" if none
}

export const exists = (r: Row) => r.english !== null;
// What a translation is checked against: the reference file's name, else the English name.
export const sourceOf = (r: Row) => r.reference || r.english || "";
const foldRow = (text: string, english: string | null, reference: string) => fold([text, english ?? "", reference].filter(Boolean).join(" "));

export function toRow(
  [slot, text, english, length, issues]: ItemTuple,
  edit: EditInfo | null = null,
  record: SlotRecord = DEFAULT_RECORD,
  dirty = edit !== null,
  reference = "",
): Row {
  return {
    slot,
    itemType: Math.floor(slot / MAX_ITEM_INDEX),
    itemIndex: slot % MAX_ITEM_INDEX,
    text,
    english,
    folded: foldRow(text, english, reference),
    length,
    issues,
    edit,
    record,
    dirty,
    reference,
  };
}

export function toRows(
  items: ItemTuple[],
  edits: EditInfo[] = [],
  records: [number, SlotRecord][] = [],
  dirty: number[] = [],
): Row[] {
  const bySlot = new Map(edits.map((e) => [e.slot, e]));
  const rec = new Map(records);
  const dirtySet = new Set(dirty);
  return items.map((t) => toRow(t, bySlot.get(t[0]) ?? null, rec.get(t[0]) ?? DEFAULT_RECORD, dirtySet.has(t[0])));
}

// Update in place (same object, so the filtered list is not reshuffled).
export function patchRow(row: Row, s: SlotState) {
  Object.assign(row, toRow(s.item, s.edit, s.record, s.dirty, row.reference));
}

export function setReference(row: Row, reference: string) {
  row.reference = reference;
  row.folded = foldRow(row.text, row.english, reference);
}

// Which items: all, only those with a name in the target language, or only those without.
export type SlotScope = "items" | "named" | "unnamed";
export const SCOPES: SlotScope[] = ["items", "named", "unnamed"];
export type Problem = "any" | "edited" | "issues" | "near-limit" | "glossary";
export const PROBLEMS: Problem[] = ["any", "edited", "issues", "near-limit", "glossary"];

export type StatusFilter = "any" | Status;

export interface Filter {
  group: number | null; // null = every ItemType
  scope: SlotScope;
  problem: Problem;
  status: StatusFilter;
  query: string;
}

// Coordinate queries: "7:1", "7 1", "7/1" -> (type 7, index 1); "#3585" -> slot 3585.
type Coord = { itemType: number; itemIndex: number } | { slot: number };

export function parseCoord(q: string): Coord | null {
  const s = q.trim();
  let m = /^#(\d{1,4})$/.exec(s);
  if (m) return { slot: Number(m[1]) };
  m = /^(\d{1,2})\s*[:/ ]\s*(\d{1,3})$/.exec(s);
  if (m) return { itemType: Number(m[1]), itemIndex: Number(m[2]) };
  return null;
}

export function matchesScope(r: Row, scope: SlotScope): boolean {
  if (!exists(r)) return false;
  if (scope === "named") return r.text !== "";
  if (scope === "unnamed") return r.text === "";
  return true;
}

export const glossaryProblems = (r: Row, glossary: GlossaryEntry[]) =>
  exists(r) && r.text ? checkGlossary(glossary, r.text, sourceOf(r)).filter(isProblemHint) : [];

export function matchesProblem(r: Row, problem: Problem, glossary: GlossaryEntry[] = []): boolean {
  switch (problem) {
    case "glossary":
      return glossaryProblems(r, glossary).length > 0;
    case "any":
      return true;
    case "edited":
      return r.dirty;
    case "issues":
      return r.issues.length > 0;
    case "near-limit":
      return r.length >= NEAR_LIMIT_CHARS;
  }
}

export function applyFilter(rows: Row[], f: Filter, glossary: GlossaryEntry[] = []): Row[] {
  const coord = parseCoord(f.query);
  if (coord) {
    // A coordinate query ignores the other filters: the user wants exactly that item.
    return rows.filter(
      (r) => exists(r) && ("slot" in coord ? r.slot === coord.slot : r.itemType === coord.itemType && r.itemIndex === coord.itemIndex),
    );
  }
  const terms = fold(f.query).split(/\s+/).filter(Boolean);
  return rows.filter(
    (r) =>
      (f.group === null || r.itemType === f.group) &&
      matchesScope(r, f.scope) &&
      matchesProblem(r, f.problem, glossary) &&
      (f.status === "any" || r.record.status === f.status) &&
      terms.every((t) => r.folded.includes(t)),
  );
}

// Per ItemType: items, and items with a name in the target language (for the group list).
export function groupCounts(rows: Row[], groups: number): { items: number; named: number }[] {
  const out = Array.from({ length: groups }, () => ({ items: 0, named: 0 }));
  for (const r of rows) {
    const g = out[r.itemType];
    if (!g || !exists(r)) continue;
    g.items++;
    if (r.text) g.named++;
  }
  return out;
}
