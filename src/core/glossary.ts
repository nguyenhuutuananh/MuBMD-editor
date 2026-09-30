// glossary.ts - Team glossary: agreed translations and terms to keep as-is. Pure logic (also used by the UI).
// Copied from MuBMD-editor unchanged, so one glossary file serves both tools.
//
// Two input formats:
//  - our TSV: Term, Translation, Note, Category (Translation empty or equal to Term = keep as-is)
//  - the legacy MuMain_VI_Glossary.csv: "Loại, Thuật ngữ / Mẫu, Ghi chú" where the middle column is
//    either "Source -> Translation" (alternatives separated by " / ") or a comma list of terms to keep.

import { parseDelimited } from "./tsv";

export interface GlossaryEntry {
  term: string;
  translation: string | null; // null = keep the term as-is
  note: string;
  category: string;
}

export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  format: "tsv" | "legacy-csv";
}

export const GLOSSARY_COLUMNS = ["Term", "Translation", "Note", "Category"] as const;

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
    const [ti, tr, no, ca] = ["term", "translation", "note", "category"].map(col);
    for (const r of rows.slice(1)) {
      const term = norm(r[ti!] ?? "");
      if (!usable(term)) continue;
      const translation = tr! >= 0 ? norm(r[tr!] ?? "") : "";
      entries.push({
        term,
        translation: translation && translation !== term ? translation : null,
        note: no! >= 0 ? norm(r[no!] ?? "") : "",
        category: ca! >= 0 ? norm(r[ca!] ?? "") : "",
      });
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
  for (const e of entries) lines.push([e.term, e.translation ?? "", e.note, e.category].map(clean).join("\t"));
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
export function checkGlossary(entries: GlossaryEntry[], name: string, source: string): GlossaryHint[] {
  const hints: GlossaryHint[] = [];
  if (!entries.length || (!name && !source)) return hints;
  const seen = new Set<string>();
  const add = (kind: GlossaryHintKind, e: GlossaryEntry) => {
    const key = `${kind}|${e.term}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ kind, term: e.term, translation: e.translation, note: e.note });
  };

  for (const e of entries) {
    const inSource = source !== "" && containsWord(source, e.term);
    if (e.translation === null) {
      if (inSource) add(name && !containsWord(name, e.term) ? "keep" : "ok", e);
      continue;
    }
    if (inSource) add(name && !containsFolded(name, e.translation) ? "missing" : "ok", e);
    // Source term left inside the translated name (e.g. "Đồng Helm" with Helm -> Mũ).
    if (name && containsWord(name, e.term) && !containsFolded(name, e.translation)) add("untranslated", e);
  }
  return hints;
}

export const isProblemHint = (h: GlossaryHint) => h.kind !== "ok";
