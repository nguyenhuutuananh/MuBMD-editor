// format.ts - Hằng số định dạng Item.bmd (MuMain) + mã hoá XOR + checksum.
// Chuyển từ tools/item_ts/src/itemBmdCore.ts (đã kiểm chứng khớp từng byte với bản Python).

import { AppError } from "./errors";

export const XOR_KEY = [0xfc, 0xcf, 0xab] as const;
export const RECORD_SIZE = 84;
export const NAME_LEN = 50; // gồm cả byte kết thúc 0x00
export const MAX_ITEM_TYPE = 16;
export const MAX_ITEM_INDEX = 512;
export const MAX_ITEM = MAX_ITEM_TYPE * MAX_ITEM_INDEX; // 8192
export const CHECKSUM_KEY = 0xe2f1;
export const BODY_SIZE = MAX_ITEM * RECORD_SIZE;
export const FILE_SIZE = BODY_SIZE + 4;

// XOR đối xứng: dùng cho cả mã hoá và giải mã. `offset` là vị trí byte đầu
// tiên của `data` tính từ đầu thân file, để mã hoá được một đoạn con đúng pha khoá.
export function buxConvert(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ XOR_KEY[(offset + i) % 3]!;
  }
  return out;
}

// Triển khai lại chính xác GenerateCheckSum2() trong ZzzInfomation.h của MuMain.
export function genCheckSum2(buf: Uint8Array, key: number = CHECKSUM_KEY): number {
  const dwKey = key >>> 0;
  let dwResult = (dwKey << 9) >>> 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let checked = 0; checked <= buf.length - 4; checked += 4) {
    const dwTemp = view.getUint32(checked, true);
    if ((checked / 4 + key) % 2 === 0) {
      dwResult = (dwResult ^ dwTemp) >>> 0;
    } else {
      dwResult = (dwResult + dwTemp) >>> 0;
    }
    if (checked % 16 === 0) {
      const shift = ((checked / 4) % 8) + 1;
      dwResult = (dwResult ^ (((dwKey + dwResult) >>> 0) >>> shift)) >>> 0;
    }
  }
  return dwResult;
}

export class InvalidSlotError extends AppError {
  constructor(field: "slot" | "itemType" | "itemIndex", value: number, max: number) {
    super("invalid-slot", `Invalid ${field}: ${value} (0..${max})`, { field, value, max });
  }
}

export function slotOf(itemType: number, itemIndex: number): number {
  if (!Number.isInteger(itemType) || itemType < 0 || itemType >= MAX_ITEM_TYPE) {
    throw new InvalidSlotError("itemType", itemType, MAX_ITEM_TYPE - 1);
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= MAX_ITEM_INDEX) {
    throw new InvalidSlotError("itemIndex", itemIndex, MAX_ITEM_INDEX - 1);
  }
  return itemType * MAX_ITEM_INDEX + itemIndex;
}

export function typeIndexOf(slot: number): { itemType: number; itemIndex: number } {
  return { itemType: Math.floor(slot / MAX_ITEM_INDEX), itemIndex: slot % MAX_ITEM_INDEX };
}
