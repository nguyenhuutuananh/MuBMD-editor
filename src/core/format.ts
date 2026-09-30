// format.ts - Item ids of MuMain: 16 groups (ItemType) x 512 numbers (ItemIndex) = 8192 slots,
// slot = group * 512 + number (the same numbering as the game's item type).

import { AppError } from "./errors";

export const MAX_ITEM_TYPE = 16;
export const MAX_ITEM_INDEX = 512;
export const MAX_ITEM = MAX_ITEM_TYPE * MAX_ITEM_INDEX; // 8192

export class InvalidSlotError extends AppError {
  constructor(field: "slot" | "itemType" | "itemIndex", value: number, max: number) {
    super("invalid-slot", `Invalid ${field}: ${value} (0..${max})`, { field, value, max });
  }
}

export const isSlot = (slot: number) => Number.isInteger(slot) && slot >= 0 && slot < MAX_ITEM;

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
