// sampleItems.ts - Synthetic MuMain item data (Data/Items/Group00_Sword.json ...) for tests and
// development, so no game data has to be committed. Written exactly like MuMain's WriteItemGroupJson
// (nlohmann dump with 2-space indent, "tags" lists on one line, "\n" at the end), so a file this
// produces with a Vietnamese name is what MuMain itself would write after adding that name.
//
// Items: every slot of item-names.tsv. English names are synthetic ("Sword 1"); the Vietnamese name
// from item-names.tsv is present only for even ItemIndex values (so both translated and untranslated
// items exist). Some items get "es" / "pt" names, tags and stats like the real files.

import * as fs from "node:fs";
import * as path from "node:path";
import { GROUP_FILE_NAMES, groupFileName, parseDelimited } from "../../src/core";

const NAMES = path.join(import.meta.dir, "item-names.tsv");

export interface SampleItem {
  group: number;
  number: number;
  names: Record<string, string>; // locale -> name (written English first, then sorted)
}

export function sampleItems(): SampleItem[] {
  const out: SampleItem[] = [];
  for (const [type, index, vi] of parseDelimited(fs.readFileSync(NAMES, "utf-8")).slice(1)) {
    const group = Number(type);
    const number = Number(index);
    const names: Record<string, string> = { en: `${GROUP_FILE_NAMES[group]} ${number}` };
    if (number % 3 === 0) names.es = `Objeto ${group}-${number}`;
    if (number % 3 === 0) names.pt = `Item ${group}-${number}`;
    if (vi && number % 2 === 0) names.vi = vi;
    out.push({ group, number, names });
  }
  return out;
}

// MuMain's WriteNames(): English first, then the translations sorted by locale.
function orderedNames(names: Record<string, string>): Record<string, string> {
  const { en = "", ...rest } = names;
  return Object.fromEntries([["en", en], ...Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))]);
}

// The text MuMain writes for one group.
export function groupJson(group: number, items: SampleItem[]): string {
  const list = items
    .filter((it) => it.group === group)
    .sort((a, b) => a.number - b.number)
    .map((it) => ({
      number: it.number,
      name: orderedNames(it.names),
      ...(it.number % 5 === 0 ? { tags: ["excellent", "valuable"] } : {}),
      width: 1 + (it.number % 2),
      height: 2,
      level: it.number * 3,
      durability: 20 + it.number,
      requirements: { strength: 40 + it.number },
      classRequirements: { darkWizard: 1, darkKnight: 1 },
    }));
  const text = JSON.stringify({ formatVersion: 1, group, items: list }, null, 2);
  return `${text.replace(/"tags": \[\s*([^\]]*?)\s*\]/g, (_, inner: string) => `"tags": [${inner.split(/,\s*/).join(", ")}]`)}\n`;
}

// { "Group00_Sword.json": text, ... } for every group that has items.
export function sampleFiles(items = sampleItems()): Record<string, string> {
  const out: Record<string, string> = {};
  for (let g = 0; g < GROUP_FILE_NAMES.length; g++) if (items.some((it) => it.group === g)) out[groupFileName(g)] = groupJson(g, items);
  return out;
}

// Write a game folder <target>/Data/Items/... (default: tests/fixtures/.generated/game) and return it.
export function writeSampleGame(target = path.join(import.meta.dir, ".generated", "game")): string {
  const dir = path.join(target, "Data", "Items");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(sampleFiles())) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf-8") !== text) fs.writeFileSync(p, text);
  }
  return target;
}

export const SAMPLE_GAME = writeSampleGame();
