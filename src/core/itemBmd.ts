// itemBmd.ts - Mô hình file Item.bmd trong bộ nhớ.
//
// Nguyên tắc: chỉ những slot bị đổi tên mới được ghi lại. Mọi byte khác (chỉ
// số item, byte rác sau 0x00 của tên không đổi...) giữ nguyên như file gốc, và
// file không sửa gì sẽ được ghi ra giống hệt từng byte.

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
  private readonly decoded: Uint8Array; // thân file đã giải mã, cập nhật khi setName
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

  // Checksum sai không chặn việc đọc (để còn cứu dữ liệu), nhưng UI nên cảnh báo.
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

  // Bản sao 50 byte tên (đã giải mã) của slot - dùng cho undo/redo chính xác từng byte.
  getNameBytes(slot: number): Uint8Array {
    return this.nameBytes(slot).slice();
  }

  // Tên của slot trong file gốc lúc mở (trước mọi chỉnh sửa).
  originalName(slot: number): DecodedName {
    const orig = this.originalNames.get(slot);
    return orig ? decodeName(orig) : this.getName(slot);
  }

  // Ném NameValidationError nếu tên không hợp lệ (quá dài, ký tự điều khiển...).
  // Đặt lại đúng tên cũ sẽ khôi phục nguyên byte gốc của slot đó.
  setName(slot: number, name: string): void {
    const encoded = encodeName(name, slot);
    const origName = this.originalName(slot);
    if (origName.encoding !== "unknown" && origName.text === decodeName(encoded).text) {
      this.revert(slot);
    } else {
      this.writeName(slot, encoded);
    }
  }

  // Ghi nguyên 50 byte tên (lấy từ getNameBytes) - không kiểm tra nội dung.
  setNameBytes(slot: number, raw: Uint8Array): void {
    if (raw.length !== NAME_LEN) {
      throw new AppError("name-bytes-length", `Name must be exactly ${NAME_LEN} bytes, got ${raw.length}.`, { expected: NAME_LEN, got: raw.length });
    }
    this.writeName(slot, raw);
  }

  // Trả slot về đúng byte gốc lúc mở file.
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

  // Ghi ra file hoàn chỉnh. Không sửa gì -> trả về bản sao y hệt file gốc
  // (kể cả khi checksum gốc sai). Có sửa -> chỉ mã hoá lại các slot đã đổi
  // và tính lại checksum.
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
