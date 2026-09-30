// rows.ts - Grid rows: accent-insensitive search, filters, per-group counts, and splitting a
// text into plain parts and the tokens the game interprets. Pure logic, no DOM.

import { type GlossaryEntry, type GlossaryHint, checkGlossary, isProblemHint } from "../../../src/core/glossary";
import { checkItemName } from "../../../src/core/itemName";
import { SEVERITY, checkValue } from "../../../src/core/validate";
import {
  type GroupInfo,
  type KeyRecord,
  ROW_DIRTY,
  ROW_KEEP,
  type RowIssue,
  type RowTuple,
  type Severity,
  type SourceKind,
  type Status,
} from "../../../src/shared/api";

// "Kiếm Rồng Đỏ" -> "kiem rong do": strip accents, đ -> d, lowercase.
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

// missing: no translation (the game shows en); same: identical to en; kept: identical to en on
// purpose ("keep" mark); extra: not in en.
export type RowState = "missing" | "same" | "kept" | "translated" | "extra";

export interface Row {
  id: number; // index in the full list
  group: number;
  source: SourceKind; // resx: a string of the UI; items: an item name
  itemType: number | null; // items: the item group (0 = swords...), the key is the item number
  key: string;
  en: string | null;
  value: string | null;
  reference: string | null;
  issues: RowIssue[];
  worst: Severity | null;
  legacyIds: number[];
  enLine: number;
  line: number;
  state: RowState;
  dirty: boolean; // unsaved change
  keep: boolean;
  saved: string | null; // the translation on disk, when dirty
  status: Status;
  record: KeyRecord | null;
  folded: string; // key + en + translation + reference, folded for search
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

export function worstOf(issues: readonly RowIssue[]): Severity | null {
  let worst: Severity | null = null;
  for (const [code] of issues) {
    const s = SEVERITY[code];
    if (!worst || RANK[s] > RANK[worst]) worst = s;
  }
  return worst;
}

export function stateOf(en: string | null, value: string | null, keep = false): RowState {
  if (en === null) return "extra";
  if (value === null) return "missing";
  if (keep) return "kept";
  return value === en ? "same" : "translated";
}

export function toRow(
  [group, key, en, value, reference, issues, legacyIds, enLine, line, flags, saved, status, record]: RowTuple,
  id: number,
  groups: readonly GroupInfo[] = [],
): Row {
  const keep = (flags & ROW_KEEP) !== 0;
  const g = groups[group];
  return {
    id,
    group,
    source: g?.source ?? "resx",
    itemType: g?.itemType ?? null,
    key,
    en,
    value,
    reference,
    issues,
    worst: worstOf(issues),
    legacyIds,
    enLine,
    line,
    state: stateOf(en, value, keep),
    dirty: (flags & ROW_DIRTY) !== 0,
    keep,
    saved,
    status,
    record,
    folded: fold([key, en ?? "", value ?? "", reference ?? "", record?.note ?? ""].join("\u0000")),
  };
}

export const toRows = (tuples: RowTuple[], groups: readonly GroupInfo[] = []): Row[] => tuples.map((t, i) => toRow(t, i, groups));

// "7:1" for an item (group : number), used as its id in the grid and in searches.
export const itemId = (r: Pick<Row, "itemType" | "key">) => `${r.itemType}:${r.key}`;

// The checks of a text being typed, as the server runs them: the value checks against en (item
// names: plus their own, see itemName.ts) and the row's en-file issues. An empty text removes the
// translation, so it has none.
export function liveIssues(row: Row, value: string, locale: string): { list: RowIssue[]; worst: Severity | null } {
  const enIssues = row.issues.filter(([, l]) => l === "en");
  if (row.en === null || value === "") return { list: enIssues, worst: worstOf(enIssues) };
  const kept = row.keep && value === row.en;
  const list: RowIssue[] = [
    ...enIssues,
    ...(kept ? [] : (row.source === "items" ? checkItemName : checkValue)(row.en, value.normalize("NFC")).map((i): RowIssue => (Object.keys(i.params).length ? [i.code, locale, i.params] : [i.code, locale]))),
  ];
  return { list, worst: worstOf(list) };
}

export type StateFilter = "any" | RowState | "dirty" | "proposal";
export type SeverityFilter = "any" | "error" | "problems" | "issues" | "clean" | "glossary";
export type StatusFilter = "any" | Status;

export interface Filter {
  source: SourceKind | null; // with group null: every group of this source (null = all)
  group: number | null; // null = every group
  state: StateFilter;
  status: StatusFilter;
  severity: SeverityFilter;
  query: string;
}

// Glossary hints of a row: the translation against its English text. Lines kept in English on
// purpose are not checked.
export const glossaryHints = (r: Row, glossary: readonly GlossaryEntry[]): GlossaryHint[] =>
  r.en === null || r.keep ? [] : checkGlossary([...glossary], r.value ?? "", r.en);
export const glossaryProblems = (r: Row, glossary: readonly GlossaryEntry[]) => (r.value === null ? [] : glossaryHints(r, glossary).filter(isProblemHint));

export function matchesSeverity(r: Row, f: SeverityFilter, glossary: readonly GlossaryEntry[] = []): boolean {
  switch (f) {
    case "glossary":
      return glossaryProblems(r, glossary).length > 0;
    case "any":
      return true;
    case "error":
      return r.worst === "error";
    case "problems":
      return r.worst === "error" || r.worst === "warning";
    case "issues":
      return r.worst !== null;
    case "clean":
      return r.worst === null;
  }
}

// "#470" finds the row with legacy_id 470 (the old GlobalText[470]), ignoring the other filters.
export function parseLegacyQuery(q: string): number | null {
  const m = /^#(\d{1,6})$/.exec(q.trim());
  return m ? Number(m[1]) : null;
}

// "7:1" (or "7/1", "7 1") finds item 1 of item group 7, ignoring the other filters.
export function parseItemQuery(q: string): { itemType: number; key: string } | null {
  const m = /^(\d{1,2})\s*[:/ ]\s*(\d{1,3})$/.exec(q.trim());
  return m ? { itemType: Number(m[1]), key: String(Number(m[2])) } : null;
}

// `hasProposal`: the row has an undecided AI proposal (state filter "proposal").
export function applyFilter(rows: Row[], f: Filter, glossary: readonly GlossaryEntry[] = [], hasProposal: (r: Row) => boolean = () => false): Row[] {
  const legacy = parseLegacyQuery(f.query);
  if (legacy !== null) return rows.filter((r) => r.legacyIds.includes(legacy));
  const item = parseItemQuery(f.query);
  if (item) return rows.filter((r) => r.source === "items" && r.itemType === item.itemType && r.key === item.key);
  const terms = fold(f.query).split(/\s+/).filter(Boolean);
  return rows.filter(
    (r) =>
      (f.group === null ? f.source === null || r.source === f.source : r.group === f.group) &&
      (f.state === "any" || (f.state === "dirty" ? r.dirty : f.state === "proposal" ? hasProposal(r) : r.state === f.state)) &&
      (f.status === "any" || r.status === f.status) &&
      matchesSeverity(r, f.severity, glossary) &&
      terms.every((t) => r.folded.includes(t)),
  );
}

// ---------------------------------------------------------------------------------------------
// Tokens

// ph: placeholder (%d, %s, {0}, %%); br: "\n" written as two characters; hash: "#" line break of
// the Item Shop texts; nl: a real line break; bad: a backslash that is not part of \n.
export type TokenKind = "text" | "ph" | "br" | "hash" | "nl" | "bad";

export interface Token {
  kind: TokenKind;
  text: string;
}

const TOKEN =
  /(\\n)|(\r?\n)|(%%|%[-+#0]*(?:\*|\d+)?(?:\.(?:\*|\d+))?(?:I64|I32|hh|ll|h|l|L|I|j|z|t|w)?[diouxXeEfFgGaAcCsSpnZ]|\{\d+\})|(#)|(\\)/g;

export function tokenize(s: string, hashBreaks = false): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    const kind: TokenKind = m[1] ? "br" : m[2] ? "nl" : m[3] ? "ph" : m[4] ? "hash" : "bad";
    if (kind === "hash" && !hashBreaks) continue;
    if (m.index > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    out.push({ kind, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out;
}

