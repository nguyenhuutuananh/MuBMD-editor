import { describe, expect, test } from "bun:test";
import { alignTerms, englishTerms, hasEnglishLeftover, namesInTexts, syllableGroups, withoutTags } from "../src/core";

const pair = (id: string, english: string, translation: string) => ({ id, english, translation });

// Item sets the way Vietnamese Mu names them: a set name (not a word-by-word translation) + the piece.
const SETS: [string, string][] = [
  ["Bronze", "Đồng"],
  ["Legendary", "Ma Thuật"],
  ["Red Wing", "Hỏa Thiên"],
];
const PIECES: [string, string][] = [
  ["Helm", "Mũ"],
  ["Armor", "Giáp"],
  ["Pants", "Quần"],
  ["Gloves", "Găng Tay"],
];
const PAIRS = SETS.flatMap(([se, sv], i) => PIECES.map(([pe, pv], j) => pair(`${7 + j}:${i}`, `${se} ${pe}`, `${pv} ${sv}`)));

describe("words and syllables", () => {
  test("English words and word pairs; stop words break a pair", () => {
    expect(englishTerms("Red Wing Helm")).toEqual(["red", "wing", "red wing", "helm", "wing helm"]);
    expect(englishTerms("Sword of Salamander")).toEqual(["sword", "salamander"]);
  });

  test("syllable groups skip class tags", () => {
    expect(syllableGroups("Cánh Tinh Thần (EFL)", 2)).toEqual(["cánh", "tinh", "thần", "cánh tinh", "tinh thần"]);
    expect(syllableGroups("Mũ SU", 1)).toEqual(["mũ"]);
    expect(withoutTags("Cánh Rồng (DK)")).toBe("Cánh Rồng");
  });
});

describe("alignTerms", () => {
  const terms = alignTerms(PAIRS, { minTogether: 3 });
  const byTerm = new Map(terms.map((t) => [t.term, t.translation]));

  test("pieces and set names, in their usual spelling", () => {
    expect(byTerm.get("helm")).toBe("Mũ");
    expect(byTerm.get("gloves")).toBe("Găng Tay");
    expect(byTerm.get("legendary")).toBe("Ma Thuật");
    expect(byTerm.get("bronze")).toBe("Đồng");
  });

  test("a two-word set name wins over its words; plain combinations are dropped", () => {
    expect(byTerm.get("red wing")).toBe("Hỏa Thiên");
    expect(byTerm.has("red")).toBe(false);
    expect(byTerm.has("wing")).toBe(false);
    expect(byTerm.has("bronze helm")).toBe(false); // = "Mũ" + "Đồng"
  });

  test("rare pairs are not candidates", () => {
    expect(alignTerms([pair("0:0", "Kris", "Chùy Thủy")]).length).toBe(0);
  });
});

describe("unfinished translations and names in texts", () => {
  test("an English word of the name left in the translation", () => {
    expect(hasEnglishLeftover("Bronze Helm", "Đồng Helm")).toBe(true);
    expect(hasEnglishLeftover("Bronze Helm", "Mũ Đồng")).toBe(false);
    expect(hasEnglishLeftover("Staff of Kundun", "Gậy Kundun", new Set(), new Set(["staff", "helm"]))).toBe(false); // a proper name
    expect(hasEnglishLeftover("Wings of Soul", "Cánh Linh Hồn (SOUL)")).toBe(false); // a class tag
    expect(hasEnglishLeftover("Guild Helm", "Mũ Guild", new Set(["guild"]))).toBe(false); // kept on purpose
  });

  test("item names used in UI texts (whole words, several words)", () => {
    const found = namesInTexts(["Jewel of Chaos", "Blade", "Wings of Dragon"], ["Use a Jewel of Chaos.", "Blade Knight", "jewel of chaos x2"]);
    expect([...found]).toEqual([["Jewel of Chaos", 2]]);
  });
});
