// errors.ts - Lỗi có mã + tham số. Server trả nguyên mã/tham số cho giao diện,
// giao diện tự dịch theo ngôn ngữ người dùng chọn (message tiếng Anh chỉ để log / dự phòng).

export type ErrorCode =
  // định dạng / dữ liệu
  | "bmd-size"
  | "invalid-slot"
  | "invalid-name"
  | "name-bytes-length"
  // phiên làm việc
  | "no-file"
  | "dirty"
  | "conflict"
  | "save-verify-failed"
  // hệ thống file
  | "file-not-found"
  | "file-locked"
  | "permission-denied"
  | "is-directory"
  | "not-a-file"
  | "disk-full"
  // hộp thoại hệ điều hành
  | "picker-unsupported"
  | "picker-failed"
  // HTTP
  | "missing-path"
  | "missing-name"
  | "bad-json"
  | "unsupported-media"
  | "not-local"
  | "unknown-api"
  | "internal";

export type ErrorParams = Record<string, string | number>;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}
