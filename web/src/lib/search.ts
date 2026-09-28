// search.ts - Accent-insensitive search + slot filtering. Pure logic, no DOM.

import { MAX_ITEM_INDEX } from "../../../src/core/format";
import type { EditInfo, ItemTuple, NameEncoding, NameIssueCode } from "../../../src/shared/api";

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
  folded: string;
  encoding: NameEncoding;
  byteLength: number;
  issues: NameIssueCode[];
  edit: EditInfo | null; // differs from the original file (unsaved)
}

export function toRow([slot, text, encoding, byteLength, issues]: ItemTuple, edit: EditInfo | null = null): Row {
  return {
    slot,
    itemType: Math.floor(slot / MAX_ITEM_INDEX),
    itemIndex: slot % MAX_ITEM_INDEX,
    text,
    folded: fold(text),
    encoding,
    byteLength,
    issues,
    edit,
  };
}

export function toRows(items: ItemTuple[], edits: EditInfo[] = []): Row[] {
  const bySlot = new Map(edits.map((e) => [e.slot, e]));
  return items.map((t) => toRow(t, bySlot.get(t[0]) ?? null));
}

// Update in place (same object, so the filtered list is not reshuffled).
export function patchRow(row: Row, item: ItemTuple, edit: EditInfo | null) {
  Object.assign(row, toRow(item, edit));
}

export type SlotScope = "named" | "all" | "empty";
export type Problem = "any" | "edited" | "issues" | "unknown-encoding" | "near-limit";

export interface Filter {
  group: number | null; // null = every ItemType
  scope: SlotScope;
  problem: Problem;
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

export function matchesProblem(r: Row, problem: Problem): boolean {
  switch (problem) {
    case "any":
      return true;
    case "edited":
      return r.edit !== null;
    case "issues":
      return r.issues.length > 0;
    case "unknown-encoding":
      return r.encoding === "unknown";
    case "near-limit":
      return r.byteLength >= NEAR_LIMIT_BYTES;
  }
}

export function applyFilter(rows: Row[], f: Filter): Row[] {
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
      matchesProblem(r, f.problem) &&
      terms.every((t) => r.folded.includes(t)),
  );
}

// Named slots / total slots per ItemType (for the group list).
export function groupCounts(rows: Row[], groups: number): { named: number; total: number }[] {
  const out = Array.from({ length: groups }, () => ({ named: 0, total: 0 }));
  for (const r of rows) {
    const g = out[r.itemType];
    if (!g) continue;
    g.total++;
    if (r.encoding !== "empty") g.named++;
  }
  return out;
}
