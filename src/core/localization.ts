// localization.ts - The MuMain/src/Localization folder: which files belong to which group and
// locale, pure logic. Mirrors ResxGen (ResxLoader.TrySplitName / SortLocales):
//   "Game.zh-TW.resx" -> group "Game", locale "zh-TW" (split at the LAST dot of the base name);
//   "en" is the default locale and the source of truth for which keys exist;
//   locales are ordered en first, then ordinal.
// Other files (Game.vi.resx.bak, README...) are listed as skipped, never read.

import { AppError } from "./errors";

export const DEFAULT_LOCALE = "en";
export const RESX_EXTENSION = ".resx";

export interface ResxFileName {
  group: string;
  locale: string;
}

export function parseResxFileName(fileName: string): ResxFileName | null {
  if (!fileName.endsWith(RESX_EXTENSION)) return null;
  const stem = fileName.slice(0, -RESX_EXTENSION.length);
  const dot = stem.lastIndexOf(".");
  if (dot <= 0 || dot === stem.length - 1) return null;
  return { group: stem.slice(0, dot), locale: stem.slice(dot + 1) };
}

export const resxFileName = (group: string, locale: string): string => `${group}.${locale}${RESX_EXTENSION}`;

export function compareLocales(a: string, b: string): number {
  if (a === b) return 0;
  if (a === DEFAULT_LOCALE) return -1;
  if (b === DEFAULT_LOCALE) return 1;
  return a < b ? -1 : 1; // ordinal, like string.CompareOrdinal
}

// A locale code this tool will create a file for: "vi", "fil", "zh-TW", "pt-BR"... The rule is
// stricter than ResxGen (which takes anything after the last dot) so that a typo does not become
// a new file.
const LOCALE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isLocaleCode(code: string): boolean {
  return LOCALE_CODE.test(code);
}

export function checkLocaleCode(code: string): void {
  if (!isLocaleCode(code)) throw new AppError("locale-code", `"${code}" is not a locale code such as vi or zh-TW`, { code });
}

export interface ResxGroupFiles {
  name: string;
  locales: string[]; // en first, then ordinal
  files: Record<string, string>; // locale -> file name
  hasDefault: boolean; // false: ResxGen stops the build ("missing the default locale")
}

export interface LocalizationListing {
  groups: ResxGroupFiles[]; // ordinal by name, like ResxGen
  skipped: string[]; // files that are not <Group>.<locale>.resx
}

export function groupResxFiles(fileNames: readonly string[]): LocalizationListing {
  const byGroup = new Map<string, Record<string, string>>();
  const skipped: string[] = [];
  for (const name of fileNames) {
    const parsed = parseResxFileName(name);
    if (!parsed) {
      skipped.push(name);
      continue;
    }
    const files = byGroup.get(parsed.group) ?? {};
    files[parsed.locale] = name;
    byGroup.set(parsed.group, files);
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, files]) => ({
      name,
      locales: Object.keys(files).sort(compareLocales),
      files,
      hasDefault: DEFAULT_LOCALE in files,
    }));
  return { groups, skipped: skipped.sort() };
}

// Every locale present in at least one group, en first (what I18N::GetAvailableLocales() lists).
export function allLocales(listing: LocalizationListing): string[] {
  const set = new Set<string>();
  for (const g of listing.groups) for (const l of g.locales) set.add(l);
  return [...set].sort(compareLocales);
}
