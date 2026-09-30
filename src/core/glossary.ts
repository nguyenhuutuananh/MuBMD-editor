// glossary.ts - Team glossary: agreed translations and terms to keep as-is. Pure logic (also used by the UI).
//
// Two input formats:
//  - our TSV: Term, Translation, Note, Category, Source, Status (Translation empty or equal to Term =
//    keep as-is). Status is "confirmed" (agreed: a translation that does not follow it is a problem)
//    or "suggested" (a candidate, e.g. found by scripts/glossary-build.ts: shown as a hint only).
//    Source says where a term comes from (e.g. "Mu VN", "Titan", "team"). Files without these
//    columns (MuBMD-editor / MuResx-editor) read as confirmed entries without a source.
//  - the legacy MuMain_VI_Glossary.csv: "Loại, Thuật ngữ / Mẫu, Ghi chú" where the middle column is
//    either "Source -> Translation" (alternatives separated by " / ") or a comma list of terms to keep.

import { parseDelimited } from "./tsv";

export type GlossaryStatus = "confirmed" | "suggested";
export const GLOSSARY_STATUSES: readonly GlossaryStatus[] = ["confirmed", "suggested"];

export interface GlossaryEntry {
  term: string;
  translation: string | null; // null = keep the term as-is
  note: string;
  category: string;
  source?: string; // where the term comes from ("" / absent = not recorded)
  status?: GlossaryStatus; // absent = confirmed
}

export const isConfirmed = (e: GlossaryEntry) => (e.status ?? "confirmed") === "confirmed";

// "confirmed" / "suggested", also in Vietnamese ("đã chốt", "đề xuất") and short forms.
export function parseGlossaryStatus(s: string): GlossaryStatus {
  const f = s.trim().normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
  return /^(suggest|de xuat|goi y|candidate|draft|proposed)/.test(f) ? "suggested" : "confirmed";
}

export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  format: "tsv" | "legacy-csv";
}

export const GLOSSARY_COLUMNS = ["Term", "Translation", "Note", "Category", "Source", "Status"] as const;

const norm = (s: string) => s.trim().normalize("NFC");
// Not real terms: placeholders ("%s"), "..." and similar filler.
const usable = (t: string) => t.length > 0 && !t.includes("%") && !/^\.+$/.test(t);
const skipCategory = (c: string) => /^(bỏ qua|bo qua|skip|ignore)/i.test(c.trim());

export function parseGlossary(text: string): GlossaryParseResult {
  const rows = parseDelimited(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const entries: GlossaryEntry[] = [];

  if (header[0] === "term" || header.includes("translation")) {
    const col = (name: string) => header.indexOf(name);
    const [ti, tr, no, ca, so, st] = ["term", "translation", "note", "category", "source", "status"].map(col);
    for (const r of rows.slice(1)) {
      const term = norm(r[ti!] ?? "");
      if (!usable(term)) continue;
      const translation = tr! >= 0 ? norm(r[tr!] ?? "") : "";
      const e: GlossaryEntry = {
        term,
        translation: translation && translation !== term ? translation : null,
        note: no! >= 0 ? norm(r[no!] ?? "") : "",
        category: ca! >= 0 ? norm(r[ca!] ?? "") : "",
      };
      const source = so! >= 0 ? norm(r[so!] ?? "") : "";
      if (source) e.source = source;
      if (st! >= 0 && parseGlossaryStatus(r[st!] ?? "") === "suggested") e.status = "suggested";
      entries.push(e);
    }
    return { entries, format: "tsv" };
  }

  // Legacy CSV: category, pattern, note
  for (const r of rows.slice(1)) {
    const [category = "", pattern = "", note = ""] = r.map(norm);
    if (!pattern || skipCategory(category)) continue;
    if (pattern.includes("->")) {
      const [src = "", dst = ""] = pattern.split("->").map(norm);
      for (const term of src.split(/\s+\/\s+/).map(norm).filter(usable)) {
        entries.push({ term, translation: dst && dst !== term ? dst : null, note, category });
      }
    } else {
      for (const term of pattern.split(",").map(norm).filter(usable)) entries.push({ term, translation: null, note, category });
    }
  }
  return { entries, format: "legacy-csv" };
}

const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ");

export function serializeGlossary(entries: GlossaryEntry[]): string {
  const lines = [GLOSSARY_COLUMNS.join("\t")];
  for (const e of entries) {
    lines.push([e.term, e.translation ?? "", e.note, e.category, e.source ?? "", e.status ?? "confirmed"].map(clean).join("\t"));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

// ---- checking a name against the glossary ----

export type GlossaryHintKind =
  | "ok" // the source term appears and the name uses the agreed translation / keeps the term
  | "missing" // the source term appears, but the name does not use the agreed translation
  | "keep" // the source term should be kept as-is, but the name does not contain it
  | "untranslated"; // the name itself still contains a source term that has an agreed translation

export interface GlossaryHint {
  kind: GlossaryHintKind;
  term: string;
  translation: string | null;
  note: string;
  suggested?: boolean; // from a suggested entry: a hint, never a problem
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();

// Whole-word, case-insensitive match (letters/digits around the term do not count as a boundary).
const cache = new Map<string, RegExp>();
function wordRe(term: string): RegExp {
  let re = cache.get(term);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu");
    cache.set(term, re);
  }
  return re;
}

const containsWord = (text: string, term: string) => wordRe(term).test(text);
const containsFolded = (text: string, part: string) => fold(text).includes(fold(part));

// `source` = the reference name (e.g. English original), may be empty; `name` = the translation.
// A term may have several suggested translations (e.g. from two servers): using any of them is fine.
export function checkGlossary(entries: GlossaryEntry[], name: string, source: string): GlossaryHint[] {
  const hints: GlossaryHint[] = [];
  if (!entries.length || (!name && !source)) return hints;
  const seen = new Set<string>();
  const add = (kind: GlossaryHintKind, e: GlossaryEntry, translation = e.translation) => {
    const key = `${kind}|${e.term}|${translation ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ kind, term: e.term, translation, note: e.note, ...(isConfirmed(e) ? {} : { suggested: true }) });
  };

  // One decision per term: the confirmed entries of a term, else all of its suggestions (a term
  // with a confirmed entry does not show its suggestions any more).
  const byTerm = new Map<string, { confirmed: GlossaryEntry[]; suggested: GlossaryEntry[] }>();
  for (const e of entries) {
    const k = e.term.toLowerCase();
    const g = byTerm.get(k) ?? { confirmed: [], suggested: [] };
    (isConfirmed(e) ? g.confirmed : g.suggested).push(e);
    byTerm.set(k, g);
  }

  for (const g of byTerm.values()) {
    const group = g.confirmed.length ? g.confirmed : g.suggested;
    const first = group[0]!;
    const inSource = source !== "" && containsWord(source, first.term);
    const keep = group.find((e) => e.translation === null);
    const alternatives = group.filter((e) => e.translation !== null);
    const used = alternatives.find((e) => name && containsFolded(name, e.translation!));
    const all = alternatives.map((e) => e.translation).join(" / ");

    if (inSource) {
      if (keep && (!name || containsWord(name, keep.term) || used)) add("ok", keep);
      else if (used) add("ok", used);
      else if (!name) add("ok", first);
      else if (keep && !alternatives.length) add("keep", keep);
      else if (alternatives.length) add("missing", alternatives[0]!, all);
      else add("keep", first);
    }
    // Source term left inside the translated name (e.g. "Đồng Helm" with Helm -> Mũ).
    if (alternatives.length && !keep && name && containsWord(name, first.term) && !used) add("untranslated", alternatives[0]!, all);
  }
  return hints;
}

// Only confirmed entries make problems; suggested ones are hints.
export const isProblemHint = (h: GlossaryHint) => h.kind !== "ok" && !h.suggested;
