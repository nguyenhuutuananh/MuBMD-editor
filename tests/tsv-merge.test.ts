import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AppError,
  type ExportRow,
  type OursView,
  type Status,
  analyzeImport,
  parseTranslationTsv,
  serializeTranslationTsv,
} from "../src/core";

const PARENT = path.join(import.meta.dir, "../..");

describe("parseTranslationTsv", () => {
  test("minimal 3-column file (old items.tsv format)", () => {
    const r = parseTranslationTsv("ItemType\tItemIndex\tName\n0\t0\tChùy Thủy\n7\t1\tMũ Rồng Đỏ\n");
    expect(r.rows.map((x) => [x.slot, x.name])).toEqual([
      [0, "Chùy Thủy"],
      [3585, "Mũ Rồng Đỏ"],
    ]);
    expect(r.columns.base).toBe(false);
    expect(r.rows[0]!.base).toBeUndefined();
  });

  test("BOM, CRLF, columns in any order, Name(…) header, unknown status ignored", () => {
    const r = parseTranslationTsv("﻿Status\tItemIndex\tItemType\tName(Japanese)\r\ntranslated\t1\t0\tダガー\r\nblanked(no VN found)\t2\t0\tx\r\n");
    expect(r.rows[0]).toMatchObject({ slot: 1, name: "ダガー", status: "translated" });
    expect(r.rows[1]!.status).toBeUndefined();
  });

  test("full export columns round-trip", () => {
    const rows: ExportRow[] = [
      { itemType: 0, itemIndex: 5, name: "Khoái Đao", status: "reviewed", translator: "An", updatedAt: "2026-09-28T04:00:00.000Z", base: "Khoái Đao Cũ", reference: "Falchion", note: "tab\there" },
    ];
    const text = serializeTranslationTsv(rows);
    expect(text.startsWith("﻿ItemType\tItemIndex\tName\tStatus")).toBe(true);
    const back = parseTranslationTsv(text).rows[0]!;
    expect(back).toMatchObject({ slot: 5, name: "Khoái Đao", status: "reviewed", translator: "An", base: "Khoái Đao Cũ", reference: "Falchion", note: "tab here" });
  });

  test("NFD input is normalized to NFC", () => {
    const r = parseTranslationTsv(`ItemType\tItemIndex\tName\n0\t0\t${"Kiếm".normalize("NFD")}\n`);
    expect(r.rows[0]!.name).toBe("Kiếm".normalize("NFC"));
  });

  test("bad slots and duplicates are reported; last duplicate wins", () => {
    const r = parseTranslationTsv("ItemType\tItemIndex\tName\n16\t0\tA\nx\t1\tB\n0\t1\tC\n0\t1\tD\n");
    expect(r.problems.map((p) => [p.line, p.code])).toEqual([
      [2, "bad-slot"],
      [3, "bad-slot"],
      [5, "duplicate"],
    ]);
    expect(r.rows.map((x) => x.name)).toEqual(["D"]);
  });

  test("missing required columns -> tsv-header error", () => {
    expect(() => parseTranslationTsv("Key\tEnglish\tVietnamese\n")).toThrow(AppError);
  });

  test("the real TSV files in the parent folder parse", () => {
    for (const file of ["items.tsv", "item_names_MuHuyenThoai_JAPANESE.tsv", "Item_vi_for_MuMain_report.tsv"]) {
      const p = path.join(PARENT, file);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, "utf-8");
      const dataLines = text.split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
      const r = parseTranslationTsv(text);
      expect(r.rows.length + r.problems.filter((x) => x.code === "bad-slot").length).toBe(dataLines);
      expect(r.problems).toEqual([]);
    }
  });
});

describe("analyzeImport", () => {
  const ours = (m: Record<number, [string, Status?]>) => (slot: number): OursView => {
    const [name, status] = m[slot] ?? [""];
    return { name, encoding: name ? "utf-8" : "empty", status: status ?? "untranslated" };
  };
  const tsv = (lines: string[]) => parseTranslationTsv(`ItemType\tItemIndex\tName\tStatus\tBaseName\n${lines.join("\n")}\n`).rows;

  test("3-way: only they changed -> apply; only we changed -> skip; both -> conflict", () => {
    const rows = tsv(["0\t0\tTheirs0\ttranslated\tBase0", "0\t1\tBase1\ttranslated\tBase1", "0\t2\tTheirs2\ttranslated\tBase2"]);
    const r = analyzeImport(rows, ours({ 0: ["Base0"], 1: ["Ours1"], 2: ["Ours2"] }));
    expect(r.items.map((i) => [i.slot, i.kind, i.take])).toEqual([
      [0, "apply", true],
      [2, "conflict", false],
    ]);
    // slot 1: theirs == base -> only we changed it, ours is newer -> counted, not listed
    expect(r.counts).toMatchObject({ apply: 1, conflict: 1, newerHere: 1, same: 0 });
  });

  test("no BaseName column -> every difference is 'apply'", () => {
    const rows = parseTranslationTsv("ItemType\tItemIndex\tName\n0\t0\tMới\n0\t1\tGiống\n").rows;
    const r = analyzeImport(rows, ours({ 0: ["Cũ"], 1: ["Giống"] }));
    expect(r.items.map((i) => [i.slot, i.kind, i.base])).toEqual([[0, "apply", null]]);
    expect(r.counts.same).toBe(1);
  });

  test("same name, different status -> 'status', taken only if theirs is further along", () => {
    const rows = tsv(["0\t0\tA\treviewed\tA", "0\t1\tB\tuntranslated\tB"]);
    const r = analyzeImport(rows, ours({ 0: ["A", "translated"], 1: ["B", "translated"] }));
    expect(r.items.map((i) => [i.slot, i.kind, i.take])).toEqual([
      [0, "status", true],
      [1, "status", false],
    ]);
  });

  test("empty names are ignored (never clear a name), invalid names are listed", () => {
    const rows = tsv(["0\t0\t\t\t", `0\t1\t${"Đ".repeat(30)}\t\t`]);
    const r = analyzeImport(rows, ours({ 0: ["A"], 1: ["B"] }));
    expect(r.counts.emptyName).toBe(1);
    expect(r.items[0]).toMatchObject({ slot: 1, kind: "invalid", take: false, issue: { code: "too-long" } });
  });

  test("a non-UTF-8 name here is replaced by an imported name", () => {
    const rows = parseTranslationTsv("ItemType\tItemIndex\tName\n0\t0\tKiếm\n").rows;
    const r = analyzeImport(rows, () => ({ name: "��", encoding: "unknown", status: "untranslated" }));
    expect(r.items[0]).toMatchObject({ kind: "apply", ours: "" });
  });
});
