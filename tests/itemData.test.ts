import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ItemData, ItemJsonError, MAX_ITEM_INDEX, NoItemError, checkItemName, jsonString, parseJsonText } from "../src/core";

const slotOf = (type: number, index: number) => type * MAX_ITEM_INDEX + index;
import { groupJson, sampleFiles, sampleItems } from "./fixtures/sampleItems";

const files = sampleFiles();
const load = (f: Record<string, string> = files) => ItemData.parse(Object.entries(f).map(([name, text]) => ({ name, text })));
const changed = (d: ItemData) => Object.fromEntries(d.changedFiles().map((f) => [f.name, f.text]));

describe("reading", () => {
  test("items, English and Vietnamese names", () => {
    const d = load();
    expect(d.itemCount).toBe(sampleItems().length);
    expect(d.english(0)).toBe("Sword 0");
    expect(d.getName(0)).toBe("Chùy Thủy");
    expect(d.getName(1)).toBe(""); // no "vi"
    expect(d.exists(1)).toBe(true);
    expect(d.exists(slotOf(15, 511))).toBe(false);
    expect(d.english(slotOf(15, 511))).toBeNull();
    expect(d.nameIn(0, "es")).toBe("Objeto 0-0");
  });

  test("a plain text name is the English name", () => {
    const d = load({ "a.json": '{"formatVersion":1,"group":2,"items":[{"number":7,"name":"Mace"}]}' });
    expect(d.english(slotOf(2, 7))).toBe("Mace");
    expect(d.getName(slotOf(2, 7))).toBe("");
  });

  test("the group comes from the file, not its name; a BOM is accepted", () => {
    const d = load({ "whatever.json": String.fromCharCode(0xfeff) + '{"group":3,"items":[{"number":1,"name":{"en":"A"}}]}' });
    expect(d.english(slotOf(3, 1))).toBe("A");
  });

  test("broken files are reported with the file name", () => {
    const bad = (text: string) => () => load({ "Group00_Sword.json": text });
    expect(bad('{"group":0,"items":[')).toThrow(ItemJsonError);
    expect(bad('{"items":[]}')).toThrow(/group/);
    expect(bad('{"group":0}')).toThrow(/items/);
    expect(bad('{"group":0,"items":[{"name":"A"}]}')).toThrow(/number/);
    expect(bad('{"group":0,"items":[{"number":1}]}')).toThrow(/name/);
    expect(bad('{"group":0,"items":[{"number":1,"name":{"en":1}}]}')).toThrow(/name.en/);
    expect(() =>
      load({ "a.json": '{"group":0,"items":[{"number":1,"name":"A"}]}', "b.json": '{"group":0,"items":[{"number":1,"name":"B"}]}' }),
    ).toThrow(/also defined in a.json/);
  });
});

describe("editing + writing", () => {
  test("an unedited folder writes nothing", () => {
    expect(load().changedFiles()).toEqual([]);
  });

  test("adding a Vietnamese name gives exactly what MuMain would write", () => {
    const d = load();
    d.setName(1, "Đoản Đao");
    d.setName(3, "Kiếm Nhật"); // has es + pt: "vi" goes after them
    const items = sampleItems();
    items.find((i) => i.group === 0 && i.number === 1)!.names.vi = "Đoản Đao";
    items.find((i) => i.group === 0 && i.number === 3)!.names.vi = "Kiếm Nhật";
    expect(changed(d)).toEqual({ "Group00_Sword.json": groupJson(0, items) });
  });

  test("changing and removing a name; only the edited file is written", () => {
    const d = load();
    d.setName(0, "Chùy Nhỏ");
    d.setName(2, ""); // removes "vi"
    const items = sampleItems();
    items.find((i) => i.group === 0 && i.number === 0)!.names.vi = "Chùy Nhỏ";
    delete items.find((i) => i.group === 0 && i.number === 2)!.names.vi;
    expect(changed(d)).toEqual({ "Group00_Sword.json": groupJson(0, items) });
  });

  test("setting the original name again is no change", () => {
    const d = load();
    d.setName(0, "X");
    d.setName(0, "Chùy Thủy");
    expect(d.isDirty).toBe(false);
    d.setName(1, "Y");
    d.revert(1);
    expect(d.changedFiles()).toEqual([]);
  });

  test("names are stored in NFC", () => {
    const d = load();
    d.setName(1, "Đoản Đao".normalize("NFD"));
    expect(d.getName(1)).toBe("Đoản Đao".normalize("NFC"));
  });

  test("slots without an item are rejected; names are checked by checkItemName", () => {
    const d = load();
    expect(() => d.setName(slotOf(15, 511), "A")).toThrow(NoItemError);
    expect(d.isDirty).toBe(false);
    expect(checkItemName("Sword", "x".repeat(50)).map((i) => i.code)).toEqual(["name-too-long"]);
    expect(checkItemName("Sword", "a||b").map((i) => i.code)).toEqual(["name-separator"]);
    expect(checkItemName("Sword", "Sword").map((i) => i.code)).toEqual(["same-as-en"]);
    expect(checkItemName("Sword", "a\u0001").map((i) => i.code)).toEqual(["name-invalid-char"]);
    expect(checkItemName("Sword", "Kiếm").length).toBe(0);
  });

  test("a plain text name becomes an object; other bytes stay the same", () => {
    const text = '{\n    "group": 1,\n    "items": [\n        { "number": 4, "name": "Axe", "width": 2 }\n    ]\r\n}';
    const d = load({ "a.json": text });
    d.setName(slotOf(1, 4), "Rìu");
    const out = d.changedFiles()[0]!.text;
    expect(out).toContain('"name": {\r\n');
    expect(out.startsWith('{\n    "group": 1,\n    "items": [\n        { "number": 4, "name": {')).toBe(true);
    expect(out.endsWith(', "width": 2 }\n    ]\r\n}')).toBe(true);
    expect(load({ "a.json": out }).getName(slotOf(1, 4))).toBe("Rìu");
  });

  test("quotes, backslashes and control characters are escaped like nlohmann::json", () => {
    expect(jsonString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(jsonString("\u0001\n")).toBe('"\\u0001\\n"');
    expect(jsonString("Rồng")).toBe('"Rồng"');
    expect(parseJsonText(jsonString('x"\\\n\u0002y')).kind).toBe("string");
  });
});

// The real item data of a MuMain checkout (set MUMAIN_DIR to run).
const real = process.env.MUMAIN_DIR ? path.join(process.env.MUMAIN_DIR, "src", "bin", "Data", "Items") : null;
describe.skipIf(!real || !fs.existsSync(real))("real MuMain item data", () => {
  const realFiles = () =>
    fs
      .readdirSync(real!)
      .filter((n) => n.endsWith(".json"))
      .map((name) => ({ name, text: fs.readFileSync(path.join(real!, name), "utf-8") }));

  test("reads every item and writes back byte-for-byte after edit + revert", () => {
    const d = ItemData.parse(realFiles());
    expect(d.itemCount).toBeGreaterThan(900);
    for (const s of d.slots()) d.setName(s, "Tên");
    expect(d.changedFiles().length).toBe(d.fileNames.length);
    for (const s of d.slots()) d.revert(s);
    expect(d.changedFiles()).toEqual([]);
  });

  test("a name added and removed again gives the original text", () => {
    const src = realFiles();
    const d = ItemData.parse(src);
    const slot = d.slots().find((s) => d.getName(s) === "")!;
    d.setName(slot, "Tên thử");
    const once = ItemData.parse(src.map((f) => d.changedFiles().find((c) => c.name === f.name) ?? f));
    once.setName(slot, "");
    const back = once.changedFiles()[0]!;
    expect(back.text).toBe(src.find((f) => f.name === back.name)!.text);
  });
});
