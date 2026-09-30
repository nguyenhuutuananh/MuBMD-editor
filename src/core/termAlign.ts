// termAlign.ts - Finds glossary candidates from names that are already translated: pairs of an
// English name and its translation (e.g. item 7:1 "Dragon Helm" / "Mũ Rồng"), matched by id, not by
// text. Pure logic, used by scripts/glossary-build.ts.
//
// Word terms come from co-occurrence: an English word (or two consecutive words) and a group of 1-3
// Vietnamese syllables that appear in the same pairs ("Helm" in 60 English names, "Mũ" in the same 60
// translations) are scored with the Dice coefficient 2·both / (english + vietnamese). Strong, frequent
// pairs are candidates. Two words that only make sense together ("Red Wing" -> "Hỏa Thiên") win over
// each of their words mapped to the same translation.

export interface NamePair {
  id: string; // e.g. "7:1"
  english: string;
  translation: string;
}

export interface TermCandidate {
  term: string; // English
  translation: string; // Vietnamese, in its most frequent spelling
  together: number; // pairs holding both
  termCount: number; // pairs holding the English term
  score: number; // Dice, 0..1
  examples: NamePair[]; // a few pairs holding both
}

const STOP = new Set(["of", "the", "a", "an", "and", "or", "for", "to", "in", "on", "with", "de", "la"]);
const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/;

const lower = (s: string) => s.normalize("NFC").toLocaleLowerCase("vi");

// English words of a name (letters only, lowercase, no stop words / numbers / roman numerals).
export function englishWords(name: string): string[] {
  return (name.match(/\p{L}[\p{L}']*/gu) ?? []).map((w) => w.toLowerCase().replace(/'s$/, "")).filter((w) => w.length > 1 && !STOP.has(w) && !ROMAN.test(w));
}

// The words of a name plus each two consecutive words ("red wing helm" -> red, wing, helm, red wing,
// wing helm); a stop word breaks a pair ("Sword of Salamander" has no "sword salamander").
export function englishTerms(name: string): string[] {
  const out = new Set<string>();
  let prev: string | null = null;
  for (const raw of name.match(/\p{L}[\p{L}']*/gu) ?? []) {
    const w = raw.toLowerCase().replace(/'s$/, "");
    if (w.length < 2 || STOP.has(w) || ROMAN.test(w)) {
      prev = null;
      continue;
    }
    out.add(w);
    if (prev) out.add(`${prev} ${w}`);
    prev = w;
  }
  return [...out];
}

// The syllables of a Vietnamese name, without class tags ("(RF)", "SU", "EFL": 2-4 capital letters)
// and bracketed notes.
function syllables(name: string): string[] {
  return name
    .normalize("NFC")
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s\-+/,.:]+/)
    .filter((s) => /\p{L}/u.test(s) && !/^[A-Z]{2,4}$/.test(s));
}

// Groups of 1..maxN consecutive syllables of a Vietnamese name, lowercase ("mũ", "mũ rồng", ...).
export function syllableGroups(name: string, maxN = 3): string[] {
  const syl = syllables(name);
  const out = new Set<string>();
  for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= syl.length; i++) out.add(lower(syl.slice(i, i + n).join(" ")));
  return [...out];
}

// True when the translation still holds a word of its English name (e.g. "Rồng Đỏ Helm"): not a
// finished translation. `keep` lists words that stay English on purpose (Zen, Guild...); `common`,
// when given, limits this to common words (Helm, Armor...: in several names), so a proper name kept
// as-is ("Gậy Kundun") is not flagged. Class tags ("(SOUL)", "EFL") never count.
export function hasEnglishLeftover(
  english: string,
  translation: string,
  keep: ReadonlySet<string> = new Set(),
  common?: ReadonlySet<string>,
): boolean {
  const en = new Set(englishWords(english));
  const words = syllables(translation).join(" ").match(/[A-Za-z][A-Za-z']+/g) ?? [];
  return words.some((w) => {
    const l = w.toLowerCase();
    return w.length > 2 && en.has(l) && !keep.has(l) && (!common || common.has(l));
  });
}

// A Vietnamese name without its class tags ("Cánh Tinh Thần (EFL)" -> "Cánh Tinh Thần").
export const withoutTags = (name: string) => name.replace(/\s*\([A-Z]{2,5}\)/g, "").replace(/\s{2,}/g, " ").trim();

// The spelling a syllable group has most often in the translations (keeps "Mũ", not "mũ").
function spelling(group: string, pairs: readonly NamePair[]): string {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const syl = syllables(p.translation);
    const n = group.split(" ").length;
    for (let i = 0; i + n <= syl.length; i++) {
      const s = syl.slice(i, i + n).join(" ");
      if (lower(s) === group) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group;
}

export function alignTerms(pairs: readonly NamePair[], opts: { minTogether?: number; minScore?: number } = {}): TermCandidate[] {
  const minTogether = opts.minTogether ?? 3;
  const minScore = opts.minScore ?? 0.5;
  const enCount = new Map<string, number>();
  const viCount = new Map<string, number>();
  const both = new Map<string, Map<string, NamePair[]>>();

  for (const p of pairs) {
    const en = new Set(englishTerms(p.english));
    const vi = new Set(syllableGroups(p.translation));
    for (const w of en) enCount.set(w, (enCount.get(w) ?? 0) + 1);
    for (const g of vi) viCount.set(g, (viCount.get(g) ?? 0) + 1);
    for (const w of en) {
      const m = both.get(w) ?? new Map<string, NamePair[]>();
      for (const g of vi) m.set(g, [...(m.get(g) ?? []), p]);
      both.set(w, m);
    }
  }

  const out: TermCandidate[] = [];
  for (const [w, m] of both) {
    let best: { g: string; together: number; score: number; list: NamePair[] } | null = null;
    for (const [g, list] of m) {
      const together = list.length;
      if (together < minTogether) continue;
      const score = (2 * together) / (enCount.get(w)! + viCount.get(g)!);
      // Ties go to the longer group ("Hỗn Nguyên" over "Hỗn" when both score the same).
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && g.length > best.g.length)) best = { g, together, score, list };
    }
    if (!best || best.score < minScore) continue;
    out.push({
      term: w,
      translation: spelling(best.g, best.list),
      together: best.together,
      termCount: enCount.get(w)!,
      score: Math.round(best.score * 100) / 100,
      examples: best.list.slice(0, 3),
    });
  }
  // "Red Wing" -> "Hỏa Thiên" explains "Red" -> "Hỏa Thiên" and "Wing" -> "Hỏa Thiên": keep the pair.
  // A pair that is just its words' translations side by side ("Bronze Helm" -> "Mũ Đồng") is dropped.
  const byTerm = new Map(out.map((c) => [c.term, c]));
  const kept = out.filter((c) => {
    const words = c.term.split(" ");
    if (words.length === 2) {
      const parts = words.map((w) => byTerm.get(w));
      if (parts.every((p) => p && p.translation !== c.translation && c.translation.toLowerCase().includes(p.translation.toLowerCase()))) return false;
      return true;
    }
    return !out.some((pair) => pair.term.split(" ").length === 2 && pair.term.split(" ").includes(c.term) && pair.translation === c.translation && pair.score >= c.score - 0.05);
  });
  return kept.sort((a, b) => b.together - a.together || b.score - a.score || (a.term < b.term ? -1 : 1));
}

// English item names that occur (whole words, case-insensitive) in UI texts, with how often.
export function namesInTexts(names: readonly string[], texts: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  const joined = texts.join("\n");
  for (const name of new Set(names)) {
    if (name.trim().split(/\s+/).length < 2) continue; // "Blade", "Crossbow": common words, not item names, in a text
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    const n = joined.match(re)?.length ?? 0;
    if (n) found.set(name, n);
  }
  return found;
}
