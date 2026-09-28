// format.ts - Item.bmd (MuMain) format constants + XOR encoding + checksum.
// Ported from tools/item_ts/src/itemBmdCore.ts (verified byte-identical to the Python version).

import { AppError } from "./errors";

export const XOR_KEY = [0xfc, 0xcf, 0xab] as const;
export const RECORD_SIZE = 84;
export const NAME_LEN = 50; // includes the 0x00 terminator
export const MAX_ITEM_TYPE = 16;
export const MAX_ITEM_INDEX = 512;
export const MAX_ITEM = MAX_ITEM_TYPE * MAX_ITEM_INDEX; // 8192
export const CHECKSUM_KEY = 0xe2f1;
export const BODY_SIZE = MAX_ITEM * RECORD_SIZE;
export const FILE_SIZE = BODY_SIZE + 4;

// Symmetric XOR: used for both encoding and decoding. `offset` is the position of the first byte
// of `data` from the start of the file body, so a sub-range can be encoded with the right key phase.
export function buxConvert(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ XOR_KEY[(offset + i) % 3]!;
  }
  return out;
}

// Exact re-implementation of GenerateCheckSum2() from MuMain's ZzzInfomation.h.
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
