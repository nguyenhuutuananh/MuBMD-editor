import { describe, expect, test } from "bun:test";
import type { GroupInfo, RowTuple } from "../src/shared/api";
import { type Filter, applyFilter, fold, itemId, liveIssues, parseItemQuery, parseLegacyQuery, stateOf, tokenize, toRows, worstOf } from "../web/src/lib/rows";

const TUPLES: RowTuple[] = [
  [0, "Gulim", "Gulim", "Gulim", null, [["same-as-en", "vi"]], [0, 18], 5, 5, 0, null, "translated", null],
  [0, "Event", "Event", "Sự kiện", "Ereignis", [], [7], 9, 9, 0, null, "translated", null],
  [0, "(%s) stat %d", "(%s) stat %d", "%d (%s)", null, [["printf-mismatch", "vi", { expected: "%s %d", actual: "%d %s" }]], [470], 13, 13, 0, null, "translated", null],
  [1, "Save Items", "Save Items", null, null, [], [], 5, 0, 0, null, "translated", null],
  [1, "Removed", null, "Đã xoá", null, [["extra-key", "vi"]], [], 0, 9, 0, null, "translated", null],
];
const rows = toRows(TUPLES);
const all: Filter = { source: null, group: null, state: "any", status: "any", severity: "any", query: "" };
const keys = (f: Partial<Filter>) => applyFilter(rows, { ...all, ...f }).map((r) => r.key);

describe("rows", () => {
  test("state and worst severity", () => {
    expect(rows.map((r) => r.state)).toEqual(["same", "translated", "translated", "missing", "extra"]);
    expect(rows.map((r) => r.worst)).toEqual(["info", null, "error", null, "warning"]);
    expect(stateOf(null, null)).toBe("extra");
    expect(worstOf([["same-as-en", "vi"], ["newline-mismatch", "vi"]])).toBe("warning");
  });

  test("filters", () => {
    expect(keys({ group: 1 })).toEqual(["Save Items", "Removed"]);
    expect(keys({ state: "missing" })).toEqual(["Save Items"]);
    expect(keys({ severity: "error" })).toEqual(["(%s) stat %d"]);
    expect(keys({ severity: "problems" })).toEqual(["(%s) stat %d", "Removed"]);
    expect(keys({ severity: "issues" })).toEqual(["Gulim", "(%s) stat %d", "Removed"]);
    expect(keys({ severity: "clean" })).toEqual(["Event", "Save Items"]);
  });

  test("accent-insensitive search over key, en, translation and reference", () => {
    expect(fold("Sự Kiện Đỏ")).toBe("su kien do");
    expect(keys({ query: "su kien" })).toEqual(["Event"]);
    expect(keys({ query: "ereignis" })).toEqual(["Event"]);
    expect(keys({ query: "da xoa" })).toEqual(["Removed"]);
    expect(keys({ query: "save", group: 0 })).toEqual([]);
  });

  test("#N finds a legacy id, whatever the other filters", () => {
    expect(parseLegacyQuery(" #470 ")).toBe(470);
    expect(parseLegacyQuery("#abc")).toBeNull();
    expect(keys({ query: "#18", group: 1 })).toEqual(["Gulim"]);
    expect(keys({ query: "#470" })).toEqual(["(%s) stat %d"]);
  });
});

describe("tokenize", () => {
  const kinds = (s: string, hash = false) => tokenize(s, hash).map((t) => `${t.kind}:${t.text}`);

  test("placeholders, \\n, real line breaks, stray backslashes", () => {
    expect(kinds("Level %d: %s")).toEqual(["text:Level ", "ph:%d", "text:: ", "ph:%s"]);
    expect(kinds("a\\nb\\\nc")).toEqual(["text:a", "br:\\n", "text:b", "bad:\\", "nl:\n", "text:c"]);
    expect(kinds("Index {0} %I64d 50%%")).toEqual(["text:Index ", "ph:{0}", "text: ", "ph:%I64d", "text: 50", "ph:%%"]);
  });

  test("# is a line break only in Item Shop texts", () => {
    expect(kinds("Colosseum # %d")).toEqual(["text:Colosseum # ", "ph:%d"]);
    expect(kinds("failed!##Retry", true)).toEqual(["text:failed!", "hash:#", "hash:#", "text:Retry"]);
  });
});

describe("status and glossary filters", () => {
  const withStatus: RowTuple[] = [
    [0, "Helm", "Dragon Helm", "Mũ Rồng", null, [], [], 1, 1, 0, null, "reviewed", { status: "reviewed", note: "ok", translator: "An", updatedAt: "" }],
    [0, "Armor", "Dragon Armor", "Giáp Dragon", null, [], [], 2, 2, 0, null, "translated", null],
    [0, "Pants", "Dragon Pants", null, null, [], [], 3, 0, 0, null, "untranslated", null],
  ];
  const rs = toRows(withStatus);
  const glossary = [{ term: "Dragon", translation: "Rồng", note: "", category: "" }];
  const keys = (f: Partial<Filter>) => applyFilter(rs, { ...all, ...f }, glossary).map((r) => r.key);

  test("status", () => {
    expect(keys({ status: "reviewed" })).toEqual(["Helm"]);
    expect(keys({ status: "untranslated" })).toEqual(["Pants"]);
  });

  test("glossary problems: only translated rows", () => {
    expect(keys({ severity: "glossary" })).toEqual(["Armor"]);
  });

  test("kept rows are not checked against the glossary", () => {
    const kept = toRows([[0, "CC", "Dragon Castle", "Dragon Castle", null, [], [], 1, 1, 2, null, "translated", null]]);
    expect(applyFilter(kept, { ...all, severity: "glossary" }, glossary)).toEqual([]);
  });

  test("notes are searched", () => {
    expect(keys({ query: "ok" })).toEqual(["Helm"]);
  });
});

describe("item rows", () => {
  const group = (name: string, source: "resx" | "items", itemType: number | null): GroupInfo => ({
    source,
    name,
    itemType,
    canKeep: source === "resx",
    enFile: null,
    file: null,
    referenceFile: null,
    progress: { total: 0, translated: 0, sameAsEn: 0, kept: 0, extra: 0 },
    counts: { error: 0, warning: 0, info: 0 },
    dirty: 0,
  });
  const groups = [group("Game", "resx", null), group("Items.Helm", "items", 7)];
  const mixed = toRows(
    [
      [0, "Event", "Event", "Sự kiện", null, [], [7], 9, 9, 0, null, "translated", null],
      [1, "1", "Dragon Helm", "Mũ Rồng", null, [], [], 0, 0, 0, null, "translated", null],
      [1, "12", "Helm 12", null, null, [], [], 0, 0, 0, null, "untranslated", null],
    ],
    groups,
  );
  const keysOf = (f: Partial<Filter>) => applyFilter(mixed, { ...all, ...f }).map((r) => `${r.source}:${r.key}`);

  test("source and item group come from the groups", () => {
    expect(mixed.map((r) => [r.source, r.itemType])).toEqual([["resx", null], ["items", 7], ["items", 7]]);
    expect(itemId(mixed[1]!)).toBe("7:1");
  });

  test("filter by source; 7:1 finds an item", () => {
    expect(keysOf({ source: "items" })).toEqual(["items:1", "items:12"]);
    expect(keysOf({ source: "resx" })).toEqual(["resx:Event"]);
    expect(parseItemQuery(" 7 / 12 ")).toEqual({ itemType: 7, key: "12" });
    expect(keysOf({ query: "7:1", source: "resx" })).toEqual(["items:1"]);
    expect(keysOf({ query: "#7" })).toEqual(["resx:Event"]);
  });

  test("live checks of an item name while typing", () => {
    const r = mixed[1]!;
    expect(liveIssues(r, "Đ".repeat(50), "vi").list.map((i) => i[0])).toEqual(["name-too-long"]);
    expect(liveIssues(r, "Dragon Helm", "vi").worst).toBe("info");
    expect(liveIssues(r, "a||b", "vi").worst).toBe("error");
  });
});

describe("fallback upload filter", () => {
  test("only the files to translate", async () => {
    const { isTranslatableUpload: ok } = await import("../web/src/lib/uploadFilter");
    expect(ok("MU/src/Localization/Game.vi.resx")).toBe(true);
    expect(ok("Localization/Game.en.resx")).toBe(true); // picked Localization itself
    expect(ok("MU/src/Localization/Game.vi.resx.bak")).toBe(false);
    expect(ok("MU/tools/ResxGen/Test.en.resx")).toBe(false);
    expect(ok("MU/src/bin/Data/Items/Group00_Sword.json")).toBe(true);
    expect(ok("MU/Main.app/Contents/MacOS/Data/Items/Group07_Helm.json")).toBe(true);
    expect(ok("Items/anything.json")).toBe(true);
    expect(ok("MU/src/bin/Data/Items/Models/Group00_Sword.json")).toBe(false);
    expect(ok("MU/.mumain-translator/backups/Group00_Sword-20260930-100000.json")).toBe(false);
    expect(ok("MU/.git/objects/ab/Group00_Sword.json")).toBe(false);
    expect(ok("MU/Data/Local/Item.bmd")).toBe(false);
  });
});
