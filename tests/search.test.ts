import { describe, expect, test } from "bun:test";
import { ItemData, MAX_ITEM, MAX_ITEM_TYPE, nameLength } from "../src/core";
import { sampleFiles } from "./fixtures/sampleItems";
import type { ItemTuple } from "../src/shared/api";
import { type Filter, applyFilter, fold, groupCounts, parseCoord, toRows } from "../web/src/lib/search";

const data = ItemData.parse(Object.entries(sampleFiles()).map(([name, text]) => ({ name, text })));
const rows = toRows(Array.from({ length: MAX_ITEM }, (_, s): ItemTuple => [s, data.getName(s), data.english(s), nameLength(data.getName(s)), []]));
const named = data.targetNames().length;
const base: Filter = { group: null, scope: "items", problem: "any", status: "any", query: "" };

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
  test("only slots with an item; with / without a Vietnamese name", () => {
    expect(applyFilter(rows, base).length).toBe(data.itemCount);
    expect(applyFilter(rows, { ...base, scope: "named" }).length).toBe(named);
    expect(applyFilter(rows, { ...base, scope: "unnamed" }).length).toBe(data.itemCount - named);
  });

  test("accent-insensitive, multi-word search over the name and the English name", () => {
    const hits = applyFilter(rows, { ...base, query: "truong kiem" });
    expect(hits.map((r) => r.text)).toContain("Trường Kiếm");
    expect(hits.every((r) => fold(r.text).includes("truong") && fold(r.text).includes("kiem"))).toBe(true);
    expect(applyFilter(rows, { ...base, query: "helm 1" }).some((r) => r.slot === 7 * 512 + 1)).toBe(true);
  });

  test("filter by group", () => {
    const helms = applyFilter(rows, { ...base, group: 7 });
    expect(helms.length).toBeGreaterThan(0);
    expect(helms.every((r) => r.itemType === 7)).toBe(true);
  });

  test("coordinate search ignores other filters, but never shows an empty slot", () => {
    const hit = applyFilter(rows, { ...base, group: 0, scope: "named", query: "7:1" });
    expect(hit.map((r) => r.english)).toEqual(["Helm 1"]);
    expect(applyFilter(rows, { ...base, query: "15:511" })).toEqual([]);
  });

  test("near the character limit", () => {
    const near = applyFilter(rows, { ...base, problem: "near-limit" });
    expect(near.every((r) => r.length >= 40)).toBe(true);
  });
});

test("groupCounts adds up", () => {
  const counts = groupCounts(rows, MAX_ITEM_TYPE);
  expect(counts.reduce((s, c) => s + c.items, 0)).toBe(data.itemCount);
  expect(counts.reduce((s, c) => s + c.named, 0)).toBe(named);
});
