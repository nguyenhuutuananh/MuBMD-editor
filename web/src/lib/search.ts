// search.ts - Accent-insensitive search + slot filtering. Pure logic, no DOM.

import { MAX_ITEM_INDEX } from "../../../src/core/format";
import { type GlossaryEntry, checkGlossary, isProblemHint } from "../../../src/core/glossary";
import {
  DEFAULT_RECORD,
  type EditInfo,
  type ItemTuple,
  type NameEncoding,
  type NameIssueCode,
  type SlotRecord,
  type SlotState,
  type Status,
} from "../../../src/shared/api";

export const NEAR_LIMIT_BYTES = 40;

// "Kiếm Rồng Đỏ" -> "kiem rong do": strip accents, đ -> d, lowercase.
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

export interface Row {
  slot: number;
  itemType: number;
  itemIndex: number;
  text: string;
  folded: string; // name + reference, folded for search
  encoding: NameEncoding;
  byteLength: number;
  issues: NameIssueCode[];
  edit: EditInfo | null; // name differs from the file on disk (unsaved)
  record: SlotRecord;
  dirty: boolean; // unsaved change of any kind (name, status, note)
  reference: string; // name from the reference file, "" if none
}

export function toRow(
  [slot, text, encoding, byteLength, issues]: ItemTuple,
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
    folded: fold(reference ? `${text} ${reference}` : text),
    encoding,
    byteLength,
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
  row.folded = fold(reference ? `${row.text} ${reference}` : row.text);
}

export type SlotScope = "named" | "all" | "empty";
export type Problem = "any" | "edited" | "issues" | "unknown-encoding" | "near-limit" | "glossary";

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
  if (scope === "all") return true;
  return scope === "empty" ? r.encoding === "empty" : r.encoding !== "empty";
}

export const glossaryProblems = (r: Row, glossary: GlossaryEntry[]) =>
  r.encoding === "unknown" ? [] : checkGlossary(glossary, r.text, r.reference).filter(isProblemHint);

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
    case "unknown-encoding":
      return r.encoding === "unknown";
    case "near-limit":
      return r.byteLength >= NEAR_LIMIT_BYTES;
  }
}

export function applyFilter(rows: Row[], f: Filter, glossary: GlossaryEntry[] = []): Row[] {
  const coord = parseCoord(f.query);
  if (coord) {
    // A coordinate query ignores the other filters: the user wants exactly that slot.
    return rows.filter((r) =>
      "slot" in coord ? r.slot === coord.slot : r.itemType === coord.itemType && r.itemIndex === coord.itemIndex,
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

// Per ItemType: named slots, total slots, translated-or-reviewed named slots (for the group list).
export function groupCounts(rows: Row[], groups: number): { named: number; total: number; done: number }[] {
  const out = Array.from({ length: groups }, () => ({ named: 0, total: 0, done: 0 }));
  for (const r of rows) {
    const g = out[r.itemType];
    if (!g) continue;
    g.total++;
    if (r.encoding !== "empty") {
      g.named++;
      if (r.record.status !== "untranslated") g.done++;
    }
  }
  return out;
}
