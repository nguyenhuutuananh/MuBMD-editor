// validate.ts - Checks for one group (Game, Dialog...): the build (ResxGen), each file, and each
// translated value against its en text. Pure logic; the UI translates `code` + `params`.
//
// Severity:
//   error   the MuMain build fails, or the game can crash / print garbage (printf arguments)
//   warning most likely shown wrong in game, or silently ignored by ResxGen
//   info    worth a look (text still identical to en)
//
// Placeholder conventions in the en files:
//   Game      printf (%d %s %lu %I64d %02X ... %% is a literal), wide: %s is widened by ResxGen
//   Editor    I18N::Format {0} {1} ({{ is a literal brace)
//   Game      line breaks written as the two characters \n, and # / ## in Item Shop messages

import { checkBuild, type BuildIssueCode } from "./resxgen";
import { findResxProblems, resxValues, type ResxDocument, type ResxEntry } from "./resx";
import { hasKeepMark } from "./keep";
import { DEFAULT_LOCALE } from "./localization";

export type Severity = "error" | "warning" | "info";

export type ValueIssueCode =
  | "printf-mismatch" // printf conversions differ from en (count, order or type)
  | "printf-added" // en is plain text (no conversion, no %%), the translation has a conversion
  | "percent-style" // "%" where en writes "%%" (or the other way round)
  | "format-arg-mismatch" // {N} placeholders differ from en
  | "newline-mismatch" // number of \n (two characters) differs from en
  | "hash-mismatch" // number of # differs from en (Item Shop line breaks)
  | "stray-backslash" // a backslash that is not part of \n (e.g. "\" + a real line break)
  | "raw-newline" // a real line break where en has none
  | "edge-whitespace" // leading / trailing whitespace differs from en
  | "empty-value" // the key is present with an empty text: the game shows nothing
  | "not-nfc" // not Unicode NFC (decomposed accents render badly in game fonts)
  | "same-as-en" // identical to en: untranslated, or meant to stay English (then mark it "keep")
  | "keep-outdated" // marked "keep" but no longer the en text (en changed since)
  // item names only (itemName.ts)
  | "name-too-long" // over 49 characters: the game cuts it
  | "name-separator" // contains "||": the game refuses to start
  | "name-invalid-char"; // a control character / broken UTF-16

export type IssueCode =
  | BuildIssueCode
  | ValueIssueCode
  | "missing-default" // the group has no en file: ResxGen stops the build
  | "duplicate-key" // the key appears twice in one file; the last one wins
  | "missing-name" // <data> without a name, ignored
  | "extra-key"; // not in en: ResxGen skips it

export const SEVERITY: Record<IssueCode, Severity> = {
  "missing-default": "error",
  "blank-key": "error",
  "identifier-too-long": "error",
  "identifier-collision": "error",
  "legacy-id-collision": "error",
  "printf-mismatch": "error",
  "format-arg-mismatch": "error",
  "duplicate-key": "warning",
  "missing-name": "warning",
  "extra-key": "warning",
  "printf-added": "warning",
  "percent-style": "warning",
  "newline-mismatch": "warning",
  "hash-mismatch": "warning",
  "stray-backslash": "warning",
  "raw-newline": "warning",
  "empty-value": "warning",
  "not-nfc": "warning",
  "edge-whitespace": "info", // often deliberate (en " Title" aligns a column; every locale trims it)
  "no-identifier": "info", // ResxGen skips it: nothing to translate, the build still passes
  "same-as-en": "info",
  "keep-outdated": "warning",
  "name-too-long": "error",
  "name-separator": "error",
  "name-invalid-char": "error",
};

export type IssueParams = Record<string, string | number>;

export interface Issue {
  code: IssueCode;
  severity: Severity;
  group: string;
  locale: string;
  key?: string;
  line?: number;
  params: IssueParams;
}

// ---------------------------------------------------------------------------------------------
// Placeholders

const PRINTF_FLAGS = "-+#0";
const PRINTF_LENGTHS = ["I64", "I32", "hh", "ll", "h", "l", "L", "I", "j", "z", "t", "w"];
const PRINTF_CONVERSIONS = "diouxXeEfFgGaAcCsSpnZ";

export interface PercentScan {
  specs: string[]; // printf conversions in order, reduced to the argument each one consumes
  escaped: number; // "%%": a percent sign in a format string
  literal: number; // a '%' that starts no conversion ("50%", "30% of", "+4 %"): plain text
}

// Reads the '%' signs of a text. What must match between languages is the argument each
// conversion consumes: flags, width and precision may differ ("%2d" = "%d"), and wide groups
// widen %s to %ls, so s / ls / ws are the same. A '%' followed by a space is treated as plain
// text: "% o" is a valid printf conversion, but in these files it is always "30% of ...".
export function scanPercent(s: string): PercentScan {
  const out: PercentScan = { specs: [], escaped: 0, literal: 0 };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "%") continue;
    let j = i + 1;
    if (s[j] === "%") {
      out.escaped++;
      i = j;
      continue;
    }
    let stars = "";
    while (j < s.length && PRINTF_FLAGS.includes(s[j]!)) j++;
    if (s[j] === "*") (stars += "*"), j++;
    else while (/[0-9]/.test(s[j] ?? "")) j++;
    if (s[j] === ".") {
      j++;
      if (s[j] === "*") (stars += "*"), j++;
      else while (/[0-9]/.test(s[j] ?? "")) j++;
    }
    let len = PRINTF_LENGTHS.find((m) => s.startsWith(m, j)) ?? "";
    j += len.length;
    const conv = s[j] ?? "";
    if (conv === "" || !PRINTF_CONVERSIONS.includes(conv)) {
      out.literal++;
      continue;
    }
    let c: string = conv;
    if ("di".includes(conv)) c = "d";
    else if ("xX".includes(conv)) c = "x";
    else if ("eEfFgGaA".includes(conv)) c = "f";
    else if ("cC".includes(conv)) c = "c";
    else if ("sS".includes(conv)) c = "s";
    if (c === "s" || c === "c") len = len === "h" ? "h" : "";
    else if (c === "f") len = len === "L" ? "L" : "";
    else if (len === "I64") len = "ll";
    else if (len === "I32") len = "";
    else if (len === "hh") len = "h";
    out.specs.push(`%${stars}${len}${c}`);
    i = j;
  }
  return out;
}

export const printfSpecs = (s: string): string[] => scanPercent(s).specs;

// {N} indexes used with I18N::Format, sorted, without repeats ("{{" is a literal brace).
export function formatArgs(s: string): number[] {
  const set = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    if (s[i + 1] === "{") {
      i++;
      continue;
    }
    const m = /^\{([0-9]+)\}/.exec(s.slice(i, i + 12));
    if (m) set.add(Number(m[1]));
  }
  return [...set].sort((a, b) => a - b);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

export interface ValueIssue {
  code: ValueIssueCode;
  params: IssueParams;
}

// Compares one translated value with its en text.
export function checkValue(en: string, value: string): ValueIssue[] {
  const issues: ValueIssue[] = [];
  const add = (code: ValueIssueCode, params: IssueParams = {}) => issues.push({ code, params });

  if (value === "" && en !== "") {
    add("empty-value");
    return issues;
  }
  if (value === en) {
    if (en.trim() !== "") add("same-as-en");
    return issues;
  }

  const se = scanPercent(en);
  const sv = scanPercent(value);
  const pe = se.specs.join(" ");
  const pv = sv.specs.join(" ");
  // A "%%" in en means the text goes through printf even without a conversion.
  if (pe !== "" || se.escaped > 0) {
    if (pe !== pv) add("printf-mismatch", { expected: pe || "-", actual: pv || "-" });
  } else if (pv !== "") {
    add("printf-added", { actual: pv });
  }
  // en writes a percent sign as "%%" (format string) or "%" (plain text); the translation must
  // do the same, or the game shows "%%" / eats the sign.
  if (se.escaped > 0 && se.literal === 0 && sv.literal > 0) add("percent-style", { expected: "%%" });
  else if (se.literal > 0 && se.escaped === 0 && sv.escaped > 0) add("percent-style", { expected: "%" });

  const fe = formatArgs(en).map((n) => `{${n}}`).join(" ");
  const fv = formatArgs(value).map((n) => `{${n}}`).join(" ");
  if (fe !== fv) add("format-arg-mismatch", { expected: fe || "-", actual: fv || "-" });

  const ne = count(en, "\\n");
  const nv = count(value, "\\n");
  if (ne !== nv) add("newline-mismatch", { expected: ne, actual: nv });

  // '#' breaks lines only in the Item Shop messages, which all contain "##" (elsewhere it is
  // plain text: "Colosseum # %d").
  if (en.includes("##")) {
    const he = count(en, "#");
    const hv = count(value, "#");
    if (he !== hv) add("hash-mismatch", { expected: he, actual: hv });
  }

  const bare = en.includes("\\\\") ? value.replace(/\\\\/g, "") : value; // en uses \\ as a literal
  const stray = /\\(?!n)/.exec(bare);
  if (stray) {
    const after = bare[stray.index + 1];
    add("stray-backslash", { next: after === undefined ? "end" : after === "\n" ? "newline" : after });
  }

  // Line breaks that follow a stray "\" are already reported above.
  const raw = count(value, "\n") - count(value, "\\\n");
  if (raw > 0 && !en.includes("\n")) add("raw-newline", { count: raw });

  const lead = (s: string) => /^\s/.test(s);
  const trail = (s: string) => /\s$/.test(s);
  if (lead(en) !== lead(value) || trail(en) !== trail(value)) {
    add("edge-whitespace", { leading: lead(value) ? 1 : 0, trailing: trail(value) ? 1 : 0 });
  }

  if (value.normalize("NFC") !== value) add("not-nfc");
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Groups

export interface LocaleProgress {
  total: number; // en keys the game can show (with an identifier)
  translated: number; // of those, present in the locale file
  sameAsEn: number; // of the translated, identical to en and not marked "keep"
  kept: number; // of the translated, marked "keep" (stays English on purpose)
  extra: number; // keys not in en
}

export interface GroupReport {
  group: string;
  issues: Issue[];
  progress: Record<string, LocaleProgress>; // per non-en locale
}

// Lines marked "keep" in their comment (see keep.ts) are meant to stay English: no same-as-en,
// but keep-outdated once the en text changes.
export function validateGroup(
  group: string,
  docs: Readonly<Record<string, ResxDocument>>, // locale -> document (en included)
): GroupReport {
  const issues: Issue[] = [];
  const push = (locale: string, code: IssueCode, params: IssueParams, entry?: { key: string; line: number }) => {
    const issue: Issue = { code, severity: SEVERITY[code], group, locale, params };
    if (entry) {
      if (entry.key !== "") issue.key = entry.key;
      if (entry.line > 0) issue.line = entry.line;
    }
    issues.push(issue);
  };
  const progress: Record<string, LocaleProgress> = {};
  const en = docs[DEFAULT_LOCALE];
  const locales = Object.keys(docs).filter((l) => l !== DEFAULT_LOCALE);

  if (!en) {
    push(DEFAULT_LOCALE, "missing-default", {});
    for (const l of locales) fileIssues(docs[l]!, (code, params, entry) => push(l, code, params, entry));
    return { group, issues, progress };
  }

  fileIssues(en, (code, params, entry) => push(DEFAULT_LOCALE, code, params, entry));
  const build = checkBuild(en);
  for (const b of build.issues) push(DEFAULT_LOCALE, b.code, b.params, b);
  const enValues = resxValues(en);

  for (const locale of locales) {
    const doc = docs[locale]!;
    fileIssues(doc, (code, params, entry) => push(locale, code, params, entry));
    const p: LocaleProgress = { total: build.identifiers.size, translated: 0, sameAsEn: 0, kept: 0, extra: 0 };
    for (const entry of resxValues(doc).values()) {
      const source = enValues.get(entry.key);
      if (!source) {
        p.extra++;
        push(locale, "extra-key", {}, entry);
        continue;
      }
      if (!build.identifiers.has(entry.key)) continue; // never shown: no-identifier / build error
      p.translated++;
      if (hasKeepMark(entry.comment)) {
        p.kept++;
        if (entry.value !== source.value) push(locale, "keep-outdated", {}, entry);
        continue;
      }
      for (const v of checkValue(source.value, entry.value)) {
        if (v.code === "same-as-en") p.sameAsEn++;
        push(locale, v.code, v.params, entry);
      }
    }
    progress[locale] = p;
  }
  return { group, issues, progress };
}

type FileIssueSink = (code: IssueCode, params: IssueParams, entry?: { key: string; line: number }) => void;

function fileIssues(doc: ResxDocument, sink: FileIssueSink): void {
  const all = new Map<string, ResxEntry[]>();
  for (const p of doc.parts) {
    if (p.kind === "data" && p.entry && p.entry.kind !== "metadata") {
      all.set(p.entry.key, [...(all.get(p.entry.key) ?? []), p.entry]);
    }
  }
  for (const problem of findResxProblems(doc)) {
    if (problem.code === "missing-name") {
      sink("missing-name", {}, { key: "", line: problem.line });
      continue;
    }
    const copies = all.get(problem.key!) ?? [];
    const winner = copies[copies.length - 1];
    // The earlier copy's text and legacy ids are what gets lost.
    const lost = copies
      .slice(0, -1)
      .flatMap((e) => e.legacyIds)
      .filter((id) => !winner?.legacyIds.includes(id));
    sink(
      "duplicate-key",
      { firstLine: copies[0]?.line ?? 0, lostLegacyIds: lost.join(",") },
      { key: problem.key!, line: problem.line },
    );
  }
}

export function countBySeverity(issues: readonly Issue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity]++;
  return out;
}
