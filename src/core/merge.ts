// merge.ts - 3-way merge of an imported translation TSV into the open folder. Pure logic.
//
//   base   = BaseText column: the translation the other translator started from ("" = none)
//   ours   = the current translation here (including unsaved edits; none = "")
//   theirs = the Translation column
//
// Only they changed it (ours == base)    -> "apply", taken by default
// Only we changed it (theirs == base)    -> skipped (ours is newer)
// Both changed it differently            -> "conflict", kept ours by default
// No BaseText column (e.g. a sheet)      -> "apply" with base = null, taken by default
// Same text, different status            -> "status", taken if theirs is further along
// An empty Translation cell never removes a translation; keys not in the en file are skipped.
// A text with an error-level check (printf placeholders...) is listed, but not taken by default.
// A new text marked "untranslated" in the file (a row exported empty, then filled in a sheet)
// comes in as "translated".
// A row whose English column differs from the en text here (the file comes from another version of
// MuMain, the English changed since) is marked `englishChanged` and not taken by default.

import { isXmlChar } from "./xml";
import { type Status, type TsvRow, statusRank } from "./tsv";
import { SEVERITY, type ValueIssue, checkValue } from "./validate";

export interface OursView {
  en: string; // the en text of the key
  value: string | null; // null = not translated here
  status: Status;
  check?: (en: string, text: string) => ValueIssue[]; // the checks of this kind of text (default: checkValue)
}

export type MergeKind = "apply" | "conflict" | "status" | "invalid";

export interface MergeItem {
  group: string;
  key: string;
  line: number;
  kind: MergeKind;
  english: string;
  ours: string | null;
  theirs: string;
  base: string | null;
  oursStatus: Status;
  theirsStatus: Status | null;
  translator: string | null;
  take: boolean; // default choice shown in the preview
  errors: ValueIssue[]; // error-level checks of `theirs` against en
  theirEnglish?: string; // set when the file's English text differs from the en text here
}

export interface MergeCounts {
  same: number; // identical, nothing to do
  newerHere: number; // only we changed it
  empty: number; // Translation cell empty -> ignored (never removes a translation)
  unknown: number; // group / key not in the en files -> ignored
  apply: number;
  conflict: number;
  status: number;
  invalid: number;
}

export interface MergeAnalysis {
  items: MergeItem[];
  counts: MergeCounts;
}

// A character a .resx file cannot hold (XML 1.0).
function hasInvalidChar(s: string): boolean {
  for (const ch of s) if (!isXmlChar(ch.codePointAt(0)!)) return true;
  return false;
}

export function analyzeImport(rows: TsvRow[], ours: (group: string, key: string) => OursView | null): MergeAnalysis {
  const counts: MergeCounts = { same: 0, newerHere: 0, empty: 0, unknown: 0, apply: 0, conflict: 0, status: 0, invalid: 0 };
  const items: MergeItem[] = [];

  for (const row of rows) {
    const theirs = row.value;
    if (theirs === "") {
      counts.empty++;
      continue;
    }
    const o = ours(row.group, row.key);
    if (!o) {
      counts.unknown++;
      continue;
    }
    const errors = (o.check ?? checkValue)(o.en, theirs).filter((i) => SEVERITY[i.code] === "error");
    const enChanged = row.english !== undefined && row.english !== "" && row.english.normalize("NFC") !== o.en.normalize("NFC");
    const item = (kind: MergeKind, take: boolean): MergeItem => ({
      group: row.group,
      key: row.key,
      line: row.line,
      kind,
      english: o.en,
      ours: o.value,
      theirs,
      base: row.base ?? null,
      oursStatus: o.status,
      theirsStatus: kind !== "status" && row.status === "untranslated" ? "translated" : (row.status ?? null),
      translator: row.translator ?? null,
      take: take && errors.length === 0 && !enChanged,
      errors,
      ...(enChanged ? { theirEnglish: row.english } : {}),
    });

    if (hasInvalidChar(theirs)) {
      items.push({ ...item("invalid", false), take: false });
      counts.invalid++;
      continue;
    }
    if (theirs === o.value) {
      if (row.status && row.status !== o.status) {
        items.push(item("status", statusRank(row.status) > statusRank(o.status)));
        counts.status++;
      } else counts.same++;
      continue;
    }
    const oursText = o.value ?? "";
    if (row.base === undefined || row.base === oursText) {
      items.push(item("apply", true));
      counts.apply++;
    } else if (row.base === theirs) {
      counts.newerHere++;
    } else {
      items.push(item("conflict", false));
      counts.conflict++;
    }
  }
  return { items, counts };
}
