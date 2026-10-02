// localeNames.ts - The workspace's own names of its locales, in .mumain-translator/locales.json:
//   {"version":1,"names":{"th":"ภาษาไทย"}}
// Used wherever the tool shows a locale and in the lines it suggests for MuMain's language list
// (registration). A name equal to MuMain's own (src/shared/locales.ts) is not stored.

import { LOCALE_NAMES } from "../shared/locales";
import { workDir } from "./sidecar";
import { type Storage, tryReadText, writeText } from "./storage";

export const localeNamesPath = (st: Storage, folder: string) => st.join(workDir(st, folder), "locales.json");

// {} when the file is missing or unreadable.
export async function readLocaleNames(st: Storage, folder: string): Promise<Record<string, string>> {
  const text = await tryReadText(st, localeNamesPath(st, folder));
  if (text === null) return {};
  try {
    const names = (JSON.parse(text) as { names?: unknown }).names;
    if (typeof names !== "object" || names === null) return {};
    return Object.fromEntries(Object.entries(names).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));
  } catch {
    return {};
  }
}

// Sets (or, with an empty name / MuMain's own name, removes) the name of `code`; returns all names.
// Nothing is written when nothing changes.
export async function writeLocaleName(st: Storage, folder: string, code: string, name: string): Promise<Record<string, string>> {
  const names = await readLocaleNames(st, folder);
  const clean = name.replace(/[\t\r\n]+/g, " ").trim().normalize("NFC");
  const next = { ...names };
  if (!clean || clean === LOCALE_NAMES[code]) delete next[code];
  else next[code] = clean;
  if (JSON.stringify(next) === JSON.stringify(names)) return names;
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
  await writeText(st, localeNamesPath(st, folder), `${JSON.stringify({ version: 1, names: sorted }, null, 2)}\n`);
  return sorted;
}
