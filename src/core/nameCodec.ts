// nameCodec.ts - Giải mã / kiểm tra / mã hoá tên item (trường Name[50] UTF-8).
//
// Khác tool cũ: tên quá dài KHÔNG bị cắt ngầm nữa mà báo lỗi, để người dịch
// biết và tự rút gọn.

import { NAME_LEN } from "./format";

export const MAX_NAME_BYTES = NAME_LEN - 1; // chừa 1 byte cho 0x00

export type NameEncoding = "empty" | "utf-8" | "unknown";

export interface DecodedName {
  text: string;
  encoding: NameEncoding;
  byteLength: number;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lossy = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

// Tên không phải UTF-8 (dữ liệu gốc Nhật/Hàn) được đánh dấu "unknown" và trả
// về bản giải mã có ký tự thay thế U+FFFD chỉ để hiển thị - Bun không có sẵn
// bộ giải mã Shift_JIS/EUC-KR nên không đoán bảng mã.
export function decodeName(raw: Uint8Array): DecodedName {
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  const bytes = raw.subarray(0, end);
  if (bytes.length === 0) return { text: "", encoding: "empty", byteLength: 0 };
  try {
    return { text: utf8Strict.decode(bytes), encoding: "utf-8", byteLength: bytes.length };
  } catch {
    return { text: utf8Lossy.decode(bytes), encoding: "unknown", byteLength: bytes.length };
  }
}

export type NameIssueCode = "too-long" | "control-char" | "lone-surrogate" | "edge-whitespace" | "double-space";

export interface NameIssue {
  code: NameIssueCode;
  severity: "error" | "warning";
  message: string;
}

export interface NameCheck {
  normalized: string; // dạng NFC - dạng sẽ được ghi vào file
  bytes: Uint8Array;
  byteLength: number;
  issues: NameIssue[];
  ok: boolean; // không có lỗi mức "error"
}

// Tiếng Việt gõ tổ hợp (NFD, ví dụ từ macOS) tốn nhiều byte hơn và có thể hiển
// thị sai trong font game, nên luôn chuẩn hoá về NFC trước khi đếm byte.
export function checkName(name: string): NameCheck {
  const normalized = name.normalize("NFC");
  const bytes = utf8Encoder.encode(normalized);
  const issues: NameIssue[] = [];

  if (bytes.length > MAX_NAME_BYTES) {
    issues.push({
      code: "too-long",
      severity: "error",
      message: `Tên dài ${bytes.length} byte, vượt giới hạn ${MAX_NAME_BYTES} byte (tiếng Việt có dấu tốn 2-3 byte/ký tự).`,
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    issues.push({ code: "control-char", severity: "error", message: "Tên chứa ký tự điều khiển (tab, xuống dòng, 0x00...)." });
  }
  if (/\p{Cs}/u.test(normalized)) {
    issues.push({ code: "lone-surrogate", severity: "error", message: "Tên chứa ký tự Unicode hỏng (surrogate lẻ)." });
  }
  if (normalized !== normalized.trim()) {
    issues.push({ code: "edge-whitespace", severity: "warning", message: "Tên có khoảng trắng ở đầu hoặc cuối." });
  }
  if (/ {2,}/.test(normalized)) {
    issues.push({ code: "double-space", severity: "warning", message: "Tên có 2 khoảng trắng liền nhau." });
  }

  return {
    normalized,
    bytes,
    byteLength: bytes.length,
    issues,
    ok: !issues.some((i) => i.severity === "error"),
  };
}

export class NameValidationError extends Error {
  constructor(
    readonly check: NameCheck,
    readonly slot?: number,
  ) {
    const where = slot === undefined ? "" : ` (slot ${slot})`;
    const errors = check.issues.filter((i) => i.severity === "error").map((i) => i.message);
    super(`Tên không hợp lệ${where}: ${errors.join(" ")}`);
    this.name = "NameValidationError";
  }
}

// Mã hoá thành đúng NAME_LEN byte, phần thừa điền 0x00. Ném NameValidationError nếu có lỗi.
export function encodeName(name: string, slot?: number): Uint8Array {
  const check = checkName(name);
  if (!check.ok) throw new NameValidationError(check, slot);
  const out = new Uint8Array(NAME_LEN);
  out.set(check.bytes, 0);
  return out;
}
