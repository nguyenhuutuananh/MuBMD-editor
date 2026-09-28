import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BODY_SIZE,
  BmdFormatError,
  FILE_SIZE,
  InvalidSlotError,
  MAX_ITEM,
  NAME_LEN,
  NameValidationError,
  RECORD_SIZE,
  ItemBmd,
  slotOf,
} from "../src/core";
import { SAMPLE_BMD } from "./fixtures/sampleBmd";

const DATA = SAMPLE_BMD; // synthetic Item.bmd: real names, fake stats (no game data in the repo)
const original = new Uint8Array(fs.readFileSync(DATA));
const load = () => ItemBmd.parse(original);

// Offsets where two files differ (ignoring the 4-byte checksum).
function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < BODY_SIZE; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe("reading the sample Item.bmd", () => {
  test("correct size, valid checksum", () => {
    const bmd = load();
    expect(original.length).toBe(FILE_SIZE);
    expect(bmd.checksumValid).toBe(true);
  });

  test("488 named slots, all UTF-8", () => {
    const named = load().entries();
    expect(named.length).toBe(488);
    expect(named.every((e) => e.encoding === "utf-8")).toBe(true);
    expect(load().entries({ includeEmpty: true }).length).toBe(MAX_ITEM);
  });

  test("names and slot coordinates are correct", () => {
    const bmd = load();
    expect(bmd.entry(0)).toMatchObject({ itemType: 0, itemIndex: 0, text: "Chùy Thủy" });
    expect(bmd.entry(slotOf(7, 1)).text).toBe("Mũ Rồng Đỏ");
    expect(bmd.entry(1036)).toMatchObject({ itemType: 2, itemIndex: 12, text: "Quyền Trượng Đại Vương", byteLength: 32 });
  });

  test("rejects a file with the wrong size", () => {
    expect(() => ItemBmd.parse(original.subarray(0, 1000))).toThrow(BmdFormatError);
  });
});

describe("writing back", () => {
  test("no edits -> byte-identical output", () => {
    expect(Buffer.from(load().toBytes()).equals(Buffer.from(original))).toBe(true);
  });

  test("editing one name changes only that slot's name bytes, new checksum is valid", () => {
    const bmd = load();
    const slot = slotOf(0, 1);
    bmd.setName(slot, "Đoản Kiếm Thử");
    const out = bmd.toBytes();

    const offs = diffOffsets(original, out);
    expect(offs.length).toBeGreaterThan(0);
    expect(offs.every((o) => o >= slot * RECORD_SIZE && o < slot * RECORD_SIZE + NAME_LEN)).toBe(true);

    const re = ItemBmd.parse(out);
    expect(re.checksumValid).toBe(true);
    expect(re.getName(slot).text).toBe("Đoản Kiếm Thử");
    expect(re.getName(slot - 1).text).toBe("Chùy Thủy");
  });

  test("last slot (type 15, index 511) is written with the correct XOR key phase", () => {
    const bmd = load();
    const slot = slotOf(15, 511);
    bmd.setName(slot, "Ngọc Thử Nghiệm");
    expect(ItemBmd.parse(bmd.toBytes()).getName(slot).text).toBe("Ngọc Thử Nghiệm");
  });

  test("restoring the old name clears the dirty slot, file identical to the original", () => {
    const bmd = load();
    bmd.setName(0, "Tạm");
    expect(bmd.dirtySlots).toEqual([0]);
    bmd.setName(0, "Chùy Thủy");
    expect(bmd.isDirty).toBe(false);
    expect(Buffer.from(bmd.toBytes()).equals(Buffer.from(original))).toBe(true);
  });

  test("clearing a name", () => {
    const bmd = load();
    bmd.setName(0, "");
    expect(ItemBmd.parse(bmd.toBytes()).getName(0).encoding).toBe("empty");
  });

  test("an over-long name is rejected and leaves the data unchanged", () => {
    const bmd = load();
    expect(() => bmd.setName(0, "Quyền Trượng Đại Vương Huyền Thoại Cổ")).toThrow(NameValidationError);
    expect(bmd.isDirty).toBe(false);
    expect(bmd.getName(0).text).toBe("Chùy Thủy");
  });

  test("out-of-range slot", () => {
    expect(() => load().setName(MAX_ITEM, "x")).toThrow(InvalidSlotError);
    expect(() => slotOf(16, 0)).toThrow(InvalidSlotError);
  });
});

// Cross-check against the old tool (tools/item_ts) when present in the parent folder:
// importing the same TSV must produce a byte-identical file, checksum included.
const LEGACY_CORE = path.join(import.meta.dir, "../../tools/item_ts/src/itemBmdCore.ts");
const LEGACY_TSV = path.join(import.meta.dir, "../../items.tsv");
const hasLegacy = fs.existsSync(LEGACY_CORE) && fs.existsSync(LEGACY_TSV);

describe.skipIf(!hasLegacy)("compatibility with the old item_ts tool", () => {
  test("importing items.tsv matches importItemBmd() byte for byte", async () => {
    const legacy = await import(LEGACY_CORE);
    const expected: Uint8Array = legacy.importItemBmd(DATA, LEGACY_TSV).outBytes;

    const bmd = load();
    for (const [key, name] of legacy.loadItemTsv(LEGACY_TSV) as Map<string, string>) {
      const [t, i] = key.split(":").map(Number);
      bmd.setName(slotOf(t!, i!), name);
    }
    expect(Buffer.from(bmd.toBytes()).equals(Buffer.from(expected))).toBe(true);
  });
});
