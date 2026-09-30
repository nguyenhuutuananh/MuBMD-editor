import { describe, expect, test } from "bun:test";
import { AppError, type OursView, analyzeImport, parseTranslationTsv, serializeTranslationTsv } from "../src/core";

describe("translation TSV", () => {
  test("round trip, with texts that need quoting", () => {
    const rows = [
      { group: "Game", key: "Event", english: "Event", value: "Sự kiện", status: "translated" as const, translator: "An", updatedAt: "2026-09-29T10:00:00Z", base: "", note: "" },
      { group: "Dialog", key: "Text_1", english: 'He said "hi"', value: 'Anh ấy nói "chào"\tvà\nđi', status: "reviewed" as const, translator: "", updatedAt: "", base: "cũ", note: "xem lại" },
      { group: "Game", key: " spaced ", english: " x ", value: " y ", status: "untranslated" as const, translator: "", updatedAt: "", base: "", note: "" },
    ];
    const text = serializeTranslationTsv(rows);
    expect(text.startsWith("﻿Group\tKey\tEnglish\tTranslation\tStatus\tTranslator\tUpdatedAt\tBaseText\tNote\n")).toBe(true);
    const parsed = parseTranslationTsv(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.columns).toEqual({ base: true, status: true, translator: true, note: true });
    expect(parsed.rows.map((r) => [r.group, r.key, r.value, r.status, r.base, r.note])).toEqual([
      ["Game", "Event", "Sự kiện", "translated", "", ""],
      ["Dialog", "Text_1", 'Anh ấy nói "chào"\tvà\nđi', "reviewed", "cũ", "xem lại"],
      ["Game", " spaced ", " y ", "untranslated", "", ""],
    ]);
  });

  test("minimal sheet: columns by name, CSV, NFC, duplicates", () => {
    const csv = "Translation,Key,Group\nCấp %d,Level %d,Game\n,Event,Game\nA,Event,Game\nB,Event,Game\n,,\n";
    const parsed = parseTranslationTsv(csv);
    expect(parsed.columns).toEqual({ base: false, status: false, translator: false, note: false });
    expect(parsed.rows.map((r) => [r.key, r.value])).toEqual([
      ["Level %d", "Cấp %d"],
      ["Event", "B"],
    ]);
    expect(parsed.problems.map((p) => [p.code, p.line])).toEqual([
      ["duplicate", 4],
      ["duplicate", 5],
    ]);
  });

  test("a file without the needed columns", () => {
    try {
      parseTranslationTsv("Name\tText\nA\tB\n");
      throw new Error("no error");
    } catch (e) {
      expect((e as AppError).code).toBe("tsv-header");
    }
  });

  test("MuBMD-editor's item TSV: rows of the item groups", () => {
    const r = parseTranslationTsv("ItemType\tItemIndex\tName\tStatus\tBaseName\tReference\n0\t1\tKiếm\treviewed\tCũ\tSword\n16\t0\tX\t\t\t\n");
    expect(r.rows.map((x) => [x.group, x.key, x.value, x.status, x.base, x.english])).toEqual([["Items.Sword", "1", "Kiếm", "reviewed", "Cũ", "Sword"]]);
    expect(r.problems.map((p) => p.code)).toEqual(["missing-key"]); // ItemType 16 does not exist
  });
});

describe("3-way merge", () => {
  const ours = new Map<string, OursView>([
    ["Game/Event", { en: "Event", value: "Sự kiện", status: "translated" }],
    ["Game/Level %d", { en: "Level %d", value: null, status: "untranslated" }],
    ["Game/Gulim", { en: "Gulim", value: "Gulim", status: "untranslated" }],
    ["Game/Warning", { en: "Warning (%s)", value: "Cảnh báo (%s)", status: "translated" }],
  ]);
  const view = (g: string, k: string) => ours.get(`${g}/${k}`) ?? null;
  const tsv = (lines: string[]) => parseTranslationTsv(["Group\tKey\tTranslation\tStatus\tBaseText", ...lines].join("\n")).rows;

  test("apply / conflict / newer here / status / invalid / skipped", () => {
    const { items, counts } = analyzeImport(
      tsv([
        "Game\tLevel %d\tCấp %d\ttranslated\t", // only they changed it (we had nothing)
        "Game\tEvent\tBiến cố\ttranslated\tSự kiện cũ", // both changed
        "Game\tGulim\tGulim\treviewed\tGulim", // same text, status further along
        "Game\tWarning\tCảnh báo\ttranslated\tCảnh báo (%s)", // only they changed, but loses %s
        "Game\tEvent\t\ttranslated\t", // (duplicate row: last wins -> empty)
      ]),
      view,
    );
    expect(counts).toMatchObject({ apply: 2, conflict: 0, status: 1, empty: 1 });
    expect(items.map((i) => [i.key, i.kind, i.take, i.errors.map((e) => e.code)])).toEqual([
      ["Level %d", "apply", true, []],
      ["Gulim", "status", true, []],
      ["Warning", "apply", false, ["printf-mismatch"]],
    ]);

    const second = analyzeImport(
      tsv([
        "Game\tEvent\tBiến cố\ttranslated\tSự kiện cũ",
        "Game\tWarning\tCảnh báo (%s)\ttranslated\tCảnh báo (%s)",
        "Game\tNope\tX\ttranslated\t",
        "Game\tLevel %d\tbad\u0001\ttranslated\t",
      ]),
      view,
    );
    expect(second.counts).toMatchObject({ conflict: 1, same: 1, unknown: 1, invalid: 1 });
    expect(second.items.map((i) => [i.key, i.kind, i.take])).toEqual([
      ["Event", "conflict", false],
      ["Level %d", "invalid", false],
    ]);
  });

  test('a filled-in row still marked "untranslated" comes in as translated', () => {
    const { items } = analyzeImport(tsv(["Game\tLevel %d\tCấp %d\tuntranslated\t"]), view);
    expect(items.map((i) => [i.kind, i.theirsStatus])).toEqual([["apply", "translated"]]);
  });

  test("only we changed it: skipped; no BaseText column: every difference applies", () => {
    const newer = analyzeImport(tsv(["Game\tEvent\tSự kiện cũ\ttranslated\tSự kiện cũ"]), view);
    expect(newer.counts.newerHere).toBe(1);
    const noBase = analyzeImport(parseTranslationTsv("Group\tKey\tTranslation\nGame\tEvent\tBiến cố\n").rows, view);
    expect(noBase.items.map((i) => [i.kind, i.base])).toEqual([["apply", null]]);
  });
});
