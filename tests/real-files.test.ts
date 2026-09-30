// Runs the core on the Localization folder of a real MuMain checkout (the game's files are not
// committed here):  MUMAIN_DIR=/path/to/MuMain bun test   Skipped without it (as in CI).
// Only reads the files. Checks that hold for any checkout: upstream as cloned, or with the
// translations of a team (any locale, committed or not).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  emptyResxLike,
  findResxProblems,
  groupResxFiles,
  parseResx,
  removeResxEntry,
  resxEntries,
  resxToString,
  resxValues,
  serializeResx,
  setResxValue,
  validateGroup,
} from "../src/core";

const MUMAIN = process.env.MUMAIN_DIR;
const DIR = MUMAIN ? path.join(MUMAIN, "src/Localization") : "";
const available = DIR !== "" && fs.existsSync(DIR);
const files = available ? fs.readdirSync(DIR).filter((f) => f.endsWith(".resx")).sort() : [];
const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(DIR, f)));

describe.skipIf(!available)(`real files in ${DIR || "(MUMAIN_DIR not set)"}`, () => {
  test("found the Localization folder", () => {
    const listing = groupResxFiles(fs.readdirSync(DIR));
    expect(listing.groups.length).toBeGreaterThan(0);
    expect(listing.groups.every((g) => g.hasDefault)).toBe(true);
  });

  test("the en files do not stop the build", () => {
    for (const g of groupResxFiles(fs.readdirSync(DIR)).groups) {
      const docs = Object.fromEntries(Object.entries(g.files).map(([l, f]) => [l, parseResx(read(f))]));
      const report = validateGroup(g.name, docs);
      const buildErrors = report.issues.filter((i) => i.locale === "en" && i.severity === "error");
      expect([g.name, buildErrors]).toEqual([g.name, []]);
    }
  });

  test("a key twice in Game.en.resx can only be the known one (docs/MuMain-issues_vi.md, section 2)", () => {
    const dup = findResxProblems(parseResx(read("Game.en.resx"))).filter((p) => p.code === "duplicate-key");
    expect(dup.map((p) => p.key)).toEqual(dup.length ? ["Connecting to the server"] : []);
  });

  test.each(files)("%s: byte-exact round trip, one entry per <data>", (f) => {
    const bytes = read(f);
    const doc = parseResx(bytes);
    expect(serializeResx(doc)).toEqual(bytes);
    const text = new TextDecoder().decode(bytes);
    expect(resxEntries(doc).length).toBe(text.match(/<data\b/g)?.length ?? 0);
  });

  test.each(files.filter((f) => f.includes(".en.")))("%s: emptied and rebuilt in order gives the same bytes", (f) => {
    const full = parseResx(read(f));
    const entries = [...resxValues(full).values()];
    const order = entries.map((e) => e.key);
    let doc = emptyResxLike(full);
    for (const e of entries) doc = setResxValue(doc, e.key, e.value, { order, comment: e.comment });
    if (findResxProblems(full).length === 0) {
      expect(resxToString(doc)).toBe(resxToString(full));
    } else {
      // A duplicated key is written once, so only the values can be compared.
      const again = resxValues(parseResx(resxToString(doc)));
      expect(again.size).toBe(entries.length);
      for (const e of entries) expect(again.get(e.key)?.value).toBe(e.value);
    }
  });

  // The first translation of the Game group (whatever the locale).
  const gameTranslation = files.find((f) => f.startsWith("Game.") && !f.endsWith(".en.resx"));

  test.skipIf(!gameTranslation)("a Game translation: editing one value changes only that value", () => {
    const doc = parseResx(read(gameTranslation!));
    const target = resxEntries(doc)[100]!;
    const before = resxToString(doc);
    const next = resxToString(setResxValue(doc, target.key, target.value + " (sửa)"));
    let at = 0;
    while (before[at] === next[at]) at++;
    expect(next.slice(at, at + " (sửa)".length)).toBe(" (sửa)");
    expect(next.slice(at + " (sửa)".length)).toBe(before.slice(at));
    expect(resxToString(setResxValue(parseResx(next), target.key, target.value))).toBe(before);
  });

  test("removing then re-adding an entry of each translation file restores it", () => {
    for (const f of files.filter((x) => !x.endsWith(".en.resx"))) {
      const enFile = f.replace(/\.[^.]+\.resx$/, ".en.resx");
      if (!files.includes(enFile)) continue;
      const full = parseResx(read(f));
      const en = parseResx(read(enFile));
      const order = [...resxValues(en).keys()];
      const entries = resxEntries(full);
      for (const e of [entries[0]!, entries[Math.floor(entries.length / 2)]!, entries[entries.length - 1]!]) {
        const doc = setResxValue(removeResxEntry(full, e.key), e.key, e.value, { order, comment: e.comment });
        expect([f, e.key, resxToString(doc) === resxToString(full)]).toEqual([f, e.key, true]);
      }
    }
  });
});
