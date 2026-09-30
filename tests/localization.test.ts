import { describe, expect, test } from "bun:test";
import { allLocales, checkLocaleCode, groupResxFiles, isLocaleCode, parseResxFileName, resxFileName } from "../src/core";

describe("file names", () => {
  test("split at the last dot, like ResxGen", () => {
    expect(parseResxFileName("Game.zh-TW.resx")).toEqual({ group: "Game", locale: "zh-TW" });
    expect(parseResxFileName("My.Group.vi.resx")).toEqual({ group: "My.Group", locale: "vi" });
    for (const bad of ["Game.vi.resx.bak", "Game.resx", ".vi.resx", "Game..resx", "Game.vi.RESX", "notes.txt"]) {
      expect([bad, parseResxFileName(bad)]).toEqual([bad, null]);
    }
    expect(resxFileName("Dialog", "vi")).toBe("Dialog.vi.resx");
  });

  test("locale codes", () => {
    for (const ok of ["vi", "en", "fil", "zh-TW", "pt-BR", "sr-Latn"]) expect([ok, isLocaleCode(ok)]).toEqual([ok, true]);
    for (const bad of ["", "V", "vi_VN", "vi.", "vietnamese", "vi-", "../vi"]) expect([bad, isLocaleCode(bad)]).toEqual([bad, false]);
    expect(() => checkLocaleCode("vi_VN")).toThrow();
  });
});

describe("groupResxFiles", () => {
  test("groups, locale order (en first, then ordinal), skipped files", () => {
    const listing = groupResxFiles([
      "Game.vi.resx",
      "Game.en.resx",
      "Game.zh-TW.resx",
      "Game.de.resx",
      "Dialog.vi.resx",
      "Game.vi.resx.bak",
      "Editor.en.resx",
    ]);
    expect(listing.groups.map((g) => [g.name, g.locales, g.hasDefault])).toEqual([
      ["Dialog", ["vi"], false],
      ["Editor", ["en"], true],
      ["Game", ["en", "de", "vi", "zh-TW"], true],
    ]);
    expect(listing.groups[2]!.files["zh-TW"]).toBe("Game.zh-TW.resx");
    expect(listing.skipped).toEqual(["Game.vi.resx.bak"]);
    expect(allLocales(listing)).toEqual(["en", "de", "vi", "zh-TW"]);
  });
});
