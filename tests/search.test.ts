import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ItemBmd, MAX_ITEM, MAX_ITEM_TYPE } from "../src/core";
import type { ItemTuple } from "../src/shared/api";
import { type Filter, applyFilter, fold, groupCounts, parseCoord, toRows } from "../web/src/lib/search";

const bmd = ItemBmd.parse(new Uint8Array(fs.readFileSync(path.join(import.meta.dir, "../data/Item.bmd"))));
const rows = toRows(
  bmd.entries({ includeEmpty: true }).map((e): ItemTuple => [e.slot, e.text, e.encoding, e.byteLength, []]),
);
const base: Filter = { group: null, scope: "named", problem: "any", query: "" };

describe("fold", () => {
  test("strips Vietnamese accents, đ -> d", () => {
    expect(fold("Kiếm Rồng Đỏ")).toBe("kiem rong do");
    expect(fold("Đoản Đao")).toBe("doan dao");
    expect(fold("Kiếm".normalize("NFD"))).toBe("kiem");
  });
});

describe("parseCoord", () => {
  test("coordinate formats", () => {
    expect(parseCoord("7:1")).toEqual({ itemType: 7, itemIndex: 1 });
    expect(parseCoord("7 1")).toEqual({ itemType: 7, itemIndex: 1 });
    expect(parseCoord("#3585")).toEqual({ slot: 3585 });
    expect(parseCoord("kiem")).toBeNull();
    expect(parseCoord("7")).toBeNull();
  });
});

describe("applyFilter", () => {
  test("defaults to named slots only", () => {
    expect(applyFilter(rows, base).length).toBe(488);
    expect(applyFilter(rows, { ...base, scope: "all" }).length).toBe(MAX_ITEM);
    expect(applyFilter(rows, { ...base, scope: "empty" }).length).toBe(MAX_ITEM - 488);
  });

  test("accent-insensitive, multi-word search", () => {
    const hits = applyFilter(rows, { ...base, query: "rong do" });
    expect(hits.some((r) => r.text === "Mũ Rồng Đỏ")).toBe(true);
    expect(hits.every((r) => fold(r.text).includes("rong") && fold(r.text).includes("do"))).toBe(true);
  });

  test("filter by group", () => {
    const helms = applyFilter(rows, { ...base, group: 7 });
    expect(helms.length).toBeGreaterThan(0);
    expect(helms.every((r) => r.itemType === 7)).toBe(true);
  });

  test("coordinate search ignores other filters", () => {
    const hit = applyFilter(rows, { ...base, group: 0, scope: "empty", query: "7:1" });
    expect(hit.map((r) => r.text)).toEqual(["Mũ Rồng Đỏ"]);
  });

  test("near the byte limit", () => {
    const near = applyFilter(rows, { ...base, problem: "near-limit" });
    expect(near.every((r) => r.byteLength >= 40)).toBe(true);
  });
});

test("groupCounts adds up", () => {
  const counts = groupCounts(rows, MAX_ITEM_TYPE);
  expect(counts.reduce((s, c) => s + c.named, 0)).toBe(488);
  expect(counts.every((c) => c.total === 512)).toBe(true);
});
