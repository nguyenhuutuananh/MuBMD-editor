// glossary-build.ts - Builds a starting glossary and item-name translations from names already
// translated elsewhere (a Vietnamese Mu client, other servers...), matched with MuMain's English item
// names by id (ItemType:ItemIndex), never by text.
//
//   bun run glossary:build -- --mumain /path/to/MuMain \
//       --source "Mu VN=/path/items.tsv" --source "Titan=/path/titan_vipshop_names_vi.tsv" \
//       [--glossary /path/MuMain_VI_Glossary.csv] --out /path/translation-kit/vi
//
// --source files: TSV / CSV with ItemType, ItemIndex and a name column (Name, TiengViet...), as
// exported by MuBMD-editor or item_ts. Listed in order of preference.
//
// Writes into --out (existing files there are replaced; nothing else is touched):
//   items-vi.tsv   one row per MuMain item with a translation, in MuMain-translator's TSV format:
//                  import it (Actions -> Import translations) and review in the preview
//   glossary.tsv   the existing glossary (confirmed) + suggested terms: item names that appear in the
//                  UI texts, and words found by co-occurrence (Helm -> Mũ); confirm them in the tool
//   report.md      what was found: counts, disagreements between sources, unfinished names

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_LOCALE,
  GROUP_FILE_NAMES,
  type GlossaryEntry,
  ItemData,
  MAX_ITEM_INDEX,
  alignTerms,
  groupResxFiles,
  hasEnglishLeftover,
  isConfirmed,
  englishWords,
  isItemFileName,
  namesInTexts,
  parseGlossary,
  parseResx,
  parseTranslationTsv,
  resxValues,
  serializeGlossary,
  serializeTranslationTsv,
  withoutTags,
} from "../src/core";
import { NodeStorage } from "../src/server/nodeStorage";
import { findItemsFolder, hostPlatform } from "../src/session/itemsFolder";

// ---- arguments ----

const args = process.argv.slice(2);
const values = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const one = (name: string) => values(name)[0];
const mumain = one("mumain");
const out = one("out");
const glossaryFile = one("glossary");
const sources = values("source").map((s) => {
  const eq = s.indexOf("=");
  return eq > 0 ? { label: s.slice(0, eq).trim(), file: s.slice(eq + 1).trim() } : { label: path.basename(s), file: s };
});
if (!mumain || !out || !sources.length) {
  console.error("Usage: bun run glossary:build -- --mumain <MuMain checkout or game folder> --source \"Label=file.tsv\" [--source ...] [--glossary file] --out <folder>");
  process.exit(2);
}

// ---- MuMain: English item names, UI texts ----

const st = new NodeStorage();
const itemsDir = (await findItemsFolder(st, mumain, hostPlatform(process.platform))).dir;
const files = fs
  .readdirSync(itemsDir)
  .filter(isItemFileName)
  .map((name) => ({ name, text: fs.readFileSync(path.join(itemsDir, name), "utf-8") }));
const data = ItemData.parse(files, "vi");
const idOf = (slot: number) => `${Math.floor(slot / MAX_ITEM_INDEX)}:${slot % MAX_ITEM_INDEX}`;
const english = new Map(data.slots().map((s) => [idOf(s), data.english(s) ?? ""]));

const locDir = [path.join(mumain, "src", "Localization"), path.join(mumain, "Localization")].find((d) => fs.existsSync(d));
const uiTexts: string[] = [];
if (locDir) {
  for (const g of groupResxFiles(fs.readdirSync(locDir)).groups) {
    const f = g.files[DEFAULT_LOCALE];
    if (f) for (const e of resxValues(parseResx(fs.readFileSync(path.join(locDir, f), "utf-8"))).values()) uiTexts.push(e.value);
  }
}

// ---- existing glossary ----

const existing: GlossaryEntry[] = glossaryFile
  ? parseGlossary(fs.readFileSync(glossaryFile, "utf-8")).entries.map((e) => ({ ...e, source: e.source ?? path.basename(glossaryFile) }))
  : [];
const decided = new Set(existing.filter(isConfirmed).map((e) => e.term.toLowerCase()));
const keepWords = new Set(existing.filter((e) => e.translation === null).map((e) => e.term.toLowerCase()));
// Words in at least 3 English item names (Helm, Armor...): left in a translation, they mean unfinished.
const wordNames = new Map<string, number>();
for (const en of english.values()) for (const w of new Set(englishWords(en))) wordNames.set(w, (wordNames.get(w) ?? 0) + 1);
const commonWords = new Set([...wordNames].filter(([, n]) => n >= 3).map(([w]) => w));

// ---- translations by id, per source ----

const bySource = sources.map(({ label, file }) => {
  const names = new Map<string, string>();
  for (const r of parseTranslationTsv(fs.readFileSync(file, "utf-8")).rows) {
    const type = GROUP_FILE_NAMES.findIndex((n) => `Items.${n}` === r.group);
    if (type >= 0 && r.value) names.set(`${type}:${r.key}`, r.value);
  }
  return { label, file, names };
});

interface Choice {
  id: string;
  english: string;
  value: string;
  label: string;
  unfinished: boolean; // still holds an English word of the name
  others: { label: string; value: string }[]; // other finished translations
  unfinishedOthers: { label: string; value: string }[]; // other sources with an English word left
}

const choices: Choice[] = [];
const onlyInSources = new Map<string, string[]>(); // id -> ["Label: name", ...]
for (const [id, en] of english) {
  const found = bySource.flatMap((s) => (s.names.has(id) ? [{ label: s.label, value: s.names.get(id)! }] : [])).filter((f) => f.value !== en);
  if (!found.length) continue;
  const clean = found.find((f) => !hasEnglishLeftover(en, f.value, keepWords, commonWords));
  const pick = clean ?? found[0]!;
  const rest = found.filter((f) => f.value !== pick.value).filter((f, i, all) => all.findIndex((x) => x.value === f.value) === i);
  const done = (f: { value: string }) => !hasEnglishLeftover(en, f.value, keepWords, commonWords);
  choices.push({ id, english: en, value: pick.value, label: pick.label, unfinished: !clean, others: rest.filter(done), unfinishedOthers: rest.filter((f) => !done(f)) });
}
for (const s of bySource) {
  for (const [id, name] of s.names) if (!english.has(id)) onlyInSources.set(id, [...(onlyInSources.get(id) ?? []), `${s.label}: ${name}`]);
}

// ---- items-vi.tsv ----

fs.mkdirSync(out, { recursive: true });
const itemRows = choices.map((c) => {
  const [type, index] = c.id.split(":").map(Number) as [number, number];
  return {
    group: `Items.${GROUP_FILE_NAMES[type]}`,
    key: String(index),
    english: c.english,
    value: c.value,
    status: "translated" as const,
    translator: c.label,
    updatedAt: "",
    base: "",
    note: [c.unfinished ? "unfinished: English word left" : "", ...c.others.map((o) => `${o.label}: ${o.value}`)].filter(Boolean).join("; "),
  };
});
fs.writeFileSync(path.join(out, "items-vi.tsv"), serializeTranslationTsv(itemRows));

// ---- glossary.tsv ----

const pairs = choices.filter((c) => !c.unfinished).map((c) => ({ id: c.id, english: c.english, translation: c.value }));
// English spelling of a lowercase word, as the item names write it most often ("Helm").
const casing = new Map<string, Map<string, number>>();
for (const p of pairs) {
  for (const w of p.english.match(/\p{L}[\p{L}']*/gu) ?? []) {
    const m = casing.get(w.toLowerCase()) ?? new Map<string, number>();
    m.set(w, (m.get(w) ?? 0) + 1);
    casing.set(w.toLowerCase(), m);
  }
}
const spellWord = (w: string) => [...(casing.get(w)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? w;
const spell = (term: string) => term.split(" ").map(spellWord).join(" ");

const suggested: GlossaryEntry[] = [];
// Whole item names used in UI texts ("Jewel of Chaos" in a message): the AI needs them as terms.
const inTexts = namesInTexts(
  pairs.map((p) => p.english),
  uiTexts,
);
for (const p of pairs) {
  const n = inTexts.get(p.english);
  if (!n || decided.has(p.english.toLowerCase()) || suggested.some((e) => e.term === p.english)) continue;
  const c = choices.find((x) => x.id === p.id)!;
  suggested.push({
    term: p.english,
    translation: withoutTags(p.translation),
    note: `item ${p.id}; in ${n} UI text${n > 1 ? "s" : ""}${c.others.length ? `; also ${c.others.map((o) => `${o.label}: ${o.value}`).join(", ")}` : ""}`,
    category: "Item name",
    source: c.label,
    status: "suggested",
  });
}
// Words from co-occurrence ("Helm" -> "Mũ").
const words = alignTerms(pairs);
for (const w of words) {
  const term = spell(w.term);
  if (decided.has(term.toLowerCase()) || w.translation.toLowerCase() === term.toLowerCase()) continue;
  const labels = [...new Set(w.examples.map((e) => choices.find((c) => c.id === e.id)!.label))];
  suggested.push({
    term,
    translation: w.translation,
    note: `${w.together}/${w.termCount} names, score ${w.score}; e.g. ${w.examples.map((e) => `${e.english} → ${e.translation}`).join("; ")}`,
    category: "Word (from item names)",
    source: labels.join(", "),
    status: "suggested",
  });
}
// Re-running on a glossary built earlier: a suggestion already in it (same term and translation) is
// not added again; entries the team edited or confirmed stay as they are.
const known = new Set(existing.map((e) => `${e.term.toLowerCase()}|${(e.translation ?? "").toLowerCase()}`));
const fresh = suggested.filter((e) => !known.has(`${e.term.toLowerCase()}|${(e.translation ?? "").toLowerCase()}`));
fs.writeFileSync(path.join(out, "glossary.tsv"), serializeGlossary([...existing, ...fresh]));

// ---- report.md ----

const unfinished = choices.filter((c) => c.unfinished);
const leftovers = new Map<string, number>(); // per source: names that still have an English word
for (const c of choices) for (const o of c.unfinishedOthers) leftovers.set(o.label, (leftovers.get(o.label) ?? 0) + 1);
const disagree = choices.filter((c) => c.others.length && !c.unfinished);
const missing = [...english.keys()].filter((id) => !choices.some((c) => c.id === id));
const lines = [
  `# Glossary build - ${new Date().toISOString().slice(0, 10)}`,
  "",
  `MuMain item data: \`${itemsDir}\` (${english.size} items); UI texts: ${uiTexts.length} (${locDir ?? "no Localization folder"}).`,
  "",
  "| Source | File | Names | Matched MuMain items |",
  "|---|---|---|---|",
  ...bySource.map((s) => `| ${s.label} | \`${s.file}\` | ${s.names.size} | ${[...s.names.keys()].filter((id) => english.has(id)).length} |`),
  "",
  `- **items-vi.tsv:** ${choices.length} items with a translation (${unfinished.length} unfinished: every source still has an English word). ${missing.length} MuMain items have none yet.`,
  ...[...leftovers].map(([label, n]) => `- ${label}: ${n} names still have an English word (e.g. "Đồng Helm"); another source was used for them.`),
  `- **glossary.tsv:** ${existing.length} existing entries (kept as they were) + ${fresh.length} new suggestions (of ${suggested.length} found): ${suggested.filter((e) => e.category === "Item name").length} item names used in UI texts, ${suggested.filter((e) => e.category !== "Item name").length} words.`,
  "",
  "## Words found (suggested)",
  "",
  "| English | Vietnamese | Names | Score | Example |",
  "|---|---|---|---|---|",
  ...words.map((w) => `| ${spell(w.term)} | ${w.translation} | ${w.together}/${w.termCount} | ${w.score} | ${w.examples[0]!.english} → ${w.examples[0]!.translation} |`),
  "",
  `## Sources disagree (${disagree.length})`,
  "",
  ...disagree.map((c) => `- ${c.id} ${c.english}: **${c.value}** (${c.label}); ${c.others.map((o) => `${o.label}: ${o.value}`).join("; ")}`),
  "",
  `## Unfinished names (${unfinished.length})`,
  "",
  ...unfinished.map((c) => `- ${c.id} ${c.english}: ${[{ label: c.label, value: c.value }, ...c.others, ...c.unfinishedOthers].map((o) => `${o.label}: ${o.value}`).join("; ")}`),
  "",
  `## In the sources but not in MuMain (${onlyInSources.size})`,
  "",
  ...[...onlyInSources].map(([id, names]) => `- ${id}: ${names.join("; ")}`),
  "",
];
fs.writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`);

console.log(`items-vi.tsv: ${choices.length} items (${unfinished.length} unfinished)`);
console.log(`glossary.tsv: ${existing.length} existing + ${fresh.length} new suggestions`);
console.log(`report.md written to ${out}`);
