// merge.ts - 3-way merge of an imported translation TSV into the open file. Pure logic.
//
//   base   = BaseName column: the name the other translator started from
//   ours   = the current name here (including unsaved edits)
//   theirs = the Name column
//
// Only they changed it (ours == base)    -> "apply", taken by default
// Only we changed it (theirs == base)    -> skipped (ours is newer)
// Both changed it differently            -> "conflict", kept ours by default
// No BaseName column (older TSV files)   -> "apply" with base = null, taken by default
// Same name, different status            -> "status", taken if theirs is further along

import { checkName, type NameIssue } from "./nameCodec";
import { type Status, type TsvRow, statusRank } from "./tsv";

export interface OursView {
  name: string;
  encoding: "empty" | "utf-8" | "unknown";
  status: Status;
}

export type MergeKind = "apply" | "conflict" | "status" | "invalid";

export interface MergeItem {
  slot: number;
  itemType: number;
  itemIndex: number;
  line: number;
  kind: MergeKind;
  ours: string;
  theirs: string;
  base: string | null;
  oursStatus: Status;
  theirsStatus: Status | null;
  translator: string | null;
  take: boolean; // default choice shown in the preview
  issue: NameIssue | null; // why an "invalid" row cannot be applied
}

export interface MergeCounts {
  same: number; // identical, nothing to do
  newerHere: number; // only we changed it
  emptyName: number; // Name cell empty -> ignored (never clears a name)
  apply: number;
  conflict: number;
  status: number;
  invalid: number;
}

export interface MergeAnalysis {
  items: MergeItem[];
  counts: MergeCounts;
}

export function analyzeImport(rows: TsvRow[], ours: (slot: number) => OursView): MergeAnalysis {
  const counts: MergeCounts = { same: 0, newerHere: 0, emptyName: 0, apply: 0, conflict: 0, status: 0, invalid: 0 };
  const items: MergeItem[] = [];

  for (const row of rows) {
    const o = ours(row.slot);
    const theirs = row.name;
    if (!theirs) {
      counts.emptyName++;
      continue;
    }
    const item = (kind: MergeKind, take: boolean, issue: NameIssue | null = null): MergeItem => ({
      slot: row.slot,
      itemType: row.itemType,
      itemIndex: row.itemIndex,
      line: row.line,
      kind,
      ours: o.encoding === "unknown" ? "" : o.name,
      theirs,
      base: row.base ?? null,
      oursStatus: o.status,
      theirsStatus: row.status ?? null,
      translator: row.translator ?? null,
      take,
      issue,
    });

    const check = checkName(theirs);
    if (!check.ok) {
      items.push(item("invalid", false, check.issues.find((i) => i.severity === "error") ?? null));
      counts.invalid++;
      continue;
    }

    const oursName = o.encoding === "unknown" ? null : o.name; // a non-UTF-8 name never equals anything typed
    if (theirs === oursName) {
      if (row.status && row.status !== o.status) {
        items.push(item("status", statusRank(row.status) > statusRank(o.status)));
        counts.status++;
      } else counts.same++;
      continue;
    }

    if (row.base === undefined) {
      items.push(item("apply", true));
      counts.apply++;
    } else if (row.base === oursName) {
      items.push(item("apply", true));
      counts.apply++;
    } else if (row.base === theirs) {
      counts.newerHere++;
    } else {
      items.push(item("conflict", false));
      counts.conflict++;
    }
  }

  items.sort((a, b) => a.slot - b.slot);
  return { items, counts };
}
