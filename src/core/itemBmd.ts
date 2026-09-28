// itemBmd.ts - In-memory model of an Item.bmd file.
//
// Rule: only renamed slots are rewritten. Every other byte (item stats, garbage bytes after
// the 0x00 of unchanged names...) stays exactly as in the original, and an unedited file is
// written back byte-for-byte identical.

import {
  BODY_SIZE,
  FILE_SIZE,
  InvalidSlotError,
  MAX_ITEM,
  NAME_LEN,
  RECORD_SIZE,
  buxConvert,
  genCheckSum2,
  typeIndexOf,
} from "./format";
import { AppError } from "./errors";
import { type DecodedName, decodeName, encodeName } from "./nameCodec";

export class BmdFormatError extends AppError {
  constructor(size: number) {
    super(
      "bmd-size",
      `File is ${size} bytes, expected exactly ${FILE_SIZE} bytes ` +
        `(${MAX_ITEM} items x ${RECORD_SIZE} bytes + 4-byte checksum, MuMain Item.bmd format).`,
      { size, expected: FILE_SIZE },
    );
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ItemEntry extends DecodedName {
  slot: number;
  itemType: number;
  itemIndex: number;
}

export class ItemBmd {
  private readonly original: Uint8Array;
  private readonly decoded: Uint8Array; // decoded file body, updated by setName
  private readonly originalNames = new Map<number, Uint8Array>();
  readonly storedChecksum: number;
  readonly computedChecksum: number;

  private constructor(bytes: Uint8Array) {
    this.original = bytes.slice();
    const body = this.original.subarray(0, BODY_SIZE);
    this.decoded = buxConvert(body);
    this.storedChecksum = new DataView(this.original.buffer, BODY_SIZE, 4).getUint32(0, true);
    this.computedChecksum = genCheckSum2(body);
  }

  static parse(bytes: Uint8Array): ItemBmd {
    if (bytes.length !== FILE_SIZE) {
      throw new BmdFormatError(bytes.length);
    }
    return new ItemBmd(bytes);
  }

  // A bad checksum does not block reading (so data can be rescued), but the UI should warn.
  get checksumValid(): boolean {
    return this.storedChecksum === this.computedChecksum;
  }

  private nameBytes(slot: number): Uint8Array {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ITEM) {
      throw new InvalidSlotError("slot", slot, MAX_ITEM - 1);
    }
    const off = slot * RECORD_SIZE;
    return this.decoded.subarray(off, off + NAME_LEN);
  }

  getName(slot: number): DecodedName {
    return decodeName(this.nameBytes(slot));
  }

  entry(slot: number): ItemEntry {
    return { slot, ...typeIndexOf(slot), ...this.getName(slot) };
  }

  entries(opts: { includeEmpty?: boolean } = {}): ItemEntry[] {
    const out: ItemEntry[] = [];
    for (let slot = 0; slot < MAX_ITEM; slot++) {
      const e = this.entry(slot);
      if (opts.includeEmpty || e.encoding !== "empty") out.push(e);
    }
    return out;
  }

  // Copy of the slot's 50 decoded name bytes - used for byte-exact undo/redo.
  getNameBytes(slot: number): Uint8Array {
    return this.nameBytes(slot).slice();
  }

  // Copy of the slot's 50 name bytes in the file as opened (before any edits).
  originalNameBytes(slot: number): Uint8Array {
    return (this.originalNames.get(slot) ?? this.nameBytes(slot)).slice();
  }

  // The slot's name in the file as opened (before any edits).
  originalName(slot: number): DecodedName {
    const orig = this.originalNames.get(slot);
    return orig ? decodeName(orig) : this.getName(slot);
  }

  // Throws NameValidationError for an invalid name (too long, control characters...).
  // Setting the original name again restores the slot's original bytes exactly.
  setName(slot: number, name: string): void {
    const encoded = encodeName(name, slot);
    const origName = this.originalName(slot);
    if (origName.encoding !== "unknown" && origName.text === decodeName(encoded).text) {
      this.revert(slot);
    } else {
      this.writeName(slot, encoded);
    }
  }

  // Write raw 50 name bytes (from getNameBytes) - content is not validated.
  setNameBytes(slot: number, raw: Uint8Array): void {
    if (raw.length !== NAME_LEN) {
      throw new AppError("name-bytes-length", `Name must be exactly ${NAME_LEN} bytes, got ${raw.length}.`, { expected: NAME_LEN, got: raw.length });
    }
    this.writeName(slot, raw);
  }

  // Restore the slot to its original bytes from when the file was opened.
  revert(slot: number): void {
    const orig = this.originalNames.get(slot);
    if (orig) this.writeName(slot, orig);
  }

  private writeName(slot: number, raw: Uint8Array): void {
    const target = this.nameBytes(slot);
    if (!this.originalNames.has(slot)) this.originalNames.set(slot, target.slice());
    target.set(raw);
    if (sameBytes(target, this.originalNames.get(slot)!)) this.originalNames.delete(slot);
  }

  get dirtySlots(): number[] {
    return [...this.originalNames.keys()].sort((a, b) => a - b);
  }

  get isDirty(): boolean {
    return this.originalNames.size > 0;
  }

  // Produce the complete file. No edits -> an exact copy of the original (even if its
  // checksum was bad). With edits -> re-encode only the changed slots and recompute the checksum.
  toBytes(): Uint8Array {
    const out = this.original.slice();
    if (!this.isDirty) return out;
    for (const slot of this.originalNames.keys()) {
      const off = slot * RECORD_SIZE;
      out.set(buxConvert(this.decoded.subarray(off, off + NAME_LEN), off), off);
    }
    const checksum = genCheckSum2(out.subarray(0, BODY_SIZE));
    new DataView(out.buffer, BODY_SIZE, 4).setUint32(0, checksum, true);
    return out;
  }
}
