import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BODY_SIZE,
  BmdFormatError,
  FILE_SIZE,
  MAX_ITEM,
  NAME_LEN,
  NameValidationError,
  RECORD_SIZE,
  ItemBmd,
  slotOf,
} from "../src/core";

const DATA = path.join(import.meta.dir, "../data/Item.bmd");
const original = new Uint8Array(fs.readFileSync(DATA));
const load = () => ItemBmd.parse(original);

// Các byte khác nhau giữa 2 file (bỏ qua 4 byte checksum).
function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < BODY_SIZE; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe("đọc data/Item.bmd", () => {
  test("đúng kích thước, checksum hợp lệ", () => {
    const bmd = load();
    expect(original.length).toBe(FILE_SIZE);
    expect(bmd.checksumValid).toBe(true);
  });

  test("488 slot có tên, đều là UTF-8", () => {
    const named = load().entries();
    expect(named.length).toBe(488);
    expect(named.every((e) => e.encoding === "utf-8")).toBe(true);
    expect(load().entries({ includeEmpty: true }).length).toBe(MAX_ITEM);
  });

  test("tên và toạ độ slot đúng", () => {
    const bmd = load();
    expect(bmd.entry(0)).toMatchObject({ itemType: 0, itemIndex: 0, text: "Chùy Thủy" });
    expect(bmd.entry(slotOf(7, 1)).text).toBe("Mũ Rồng Đỏ");
    expect(bmd.entry(1036)).toMatchObject({ itemType: 2, itemIndex: 12, text: "Quyền Trượng Đại Vương", byteLength: 32 });
  });

  test("từ chối file sai kích thước", () => {
    expect(() => ItemBmd.parse(original.subarray(0, 1000))).toThrow(BmdFormatError);
  });
});

describe("ghi lại", () => {
  test("không sửa gì -> giống hệt từng byte", () => {
    expect(Buffer.from(load().toBytes()).equals(Buffer.from(original))).toBe(true);
  });

  test("sửa 1 tên -> chỉ vùng tên của slot đó đổi, checksum mới hợp lệ", () => {
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

  test("slot ở cuối file (type 15, index 511) cũng ghi đúng pha khoá XOR", () => {
    const bmd = load();
    const slot = slotOf(15, 511);
    bmd.setName(slot, "Ngọc Thử Nghiệm");
    expect(ItemBmd.parse(bmd.toBytes()).getName(slot).text).toBe("Ngọc Thử Nghiệm");
  });

  test("đặt lại tên cũ -> không còn slot bẩn, file giống hệt gốc", () => {
    const bmd = load();
    bmd.setName(0, "Tạm");
    expect(bmd.dirtySlots).toEqual([0]);
    bmd.setName(0, "Chùy Thủy");
    expect(bmd.isDirty).toBe(false);
    expect(Buffer.from(bmd.toBytes()).equals(Buffer.from(original))).toBe(true);
  });

  test("xoá trắng tên", () => {
    const bmd = load();
    bmd.setName(0, "");
    expect(ItemBmd.parse(bmd.toBytes()).getName(0).encoding).toBe("empty");
  });

  test("tên quá dài bị từ chối và không làm đổi dữ liệu", () => {
    const bmd = load();
    expect(() => bmd.setName(0, "Quyền Trượng Đại Vương Huyền Thoại Cổ")).toThrow(NameValidationError);
    expect(bmd.isDirty).toBe(false);
    expect(bmd.getName(0).text).toBe("Chùy Thủy");
  });

  test("slot ngoài phạm vi", () => {
    expect(() => load().setName(MAX_ITEM, "x")).toThrow(RangeError);
    expect(() => slotOf(16, 0)).toThrow(RangeError);
  });
});

// Đối chiếu với tool cũ (tools/item_ts) nếu có trong thư mục cha: nhập cùng 1
// file TSV phải ra file giống hệt từng byte, kể cả checksum.
const LEGACY_CORE = path.join(import.meta.dir, "../../tools/item_ts/src/itemBmdCore.ts");
const LEGACY_TSV = path.join(import.meta.dir, "../../items.tsv");
const hasLegacy = fs.existsSync(LEGACY_CORE) && fs.existsSync(LEGACY_TSV);

describe.skipIf(!hasLegacy)("tương thích tool cũ item_ts", () => {
  test("nhập items.tsv ra kết quả giống hệt importItemBmd()", async () => {
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
