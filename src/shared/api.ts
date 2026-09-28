// api.ts - Kiểu dữ liệu dùng chung giữa server (src/server) và giao diện (web/).
// Chỉ chứa type + hằng số thuần, không import gì từ node/bun.

import type { NameEncoding, NameIssueCode } from "../core/nameCodec";

export type { NameEncoding, NameIssueCode };

export interface FileInfo {
  path: string;
  fileName: string;
  size: number;
  checksumValid: boolean;
  namedCount: number;
  loadedAt: string; // ISO
}

export interface StateResponse {
  file: FileInfo | null;
  version: string;
}

// Một slot, gửi dạng mảng cho gọn (8192 dòng):
// [slot, text, encoding, byteLength, issueCodes]
export type ItemTuple = [number, string, NameEncoding, number, NameIssueCode[]];

// Ai sửa slot này lần cuối, lúc nào (để sau này gộp bản dịch nhiều người).
export interface EditMeta {
  translator: string;
  at: string; // ISO
}

// Thông tin một slot đang khác file gốc (chưa lưu).
export interface EditInfo extends EditMeta {
  slot: number;
  originalText: string;
  originalEncoding: NameEncoding;
}

export interface DocStatus {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

// Bản nháp tự lưu của lần làm việc trước chưa kịp lưu vào Item.bmd.
export interface DraftInfo {
  count: number;
  savedAt: string;
  translators: string[];
  baseMatches: boolean; // file trên đĩa vẫn là file lúc tạo nháp
}

export interface ItemsResponse {
  file: FileInfo;
  items: ItemTuple[]; // luôn đủ MAX_ITEM slot, theo thứ tự slot
  edits: EditInfo[];
  status: DocStatus;
  draft: DraftInfo | null;
}

export interface SlotState {
  item: ItemTuple;
  edit: EditInfo | null; // null = slot giống file gốc
}

// Kết quả của sửa / hoàn tác / undo / redo / khôi phục nháp.
export interface MutationResponse {
  changed: SlotState[];
  status: DocStatus;
}

export interface OpenRequest {
  path: string;
  discard?: boolean; // bỏ các thay đổi chưa lưu của file đang mở
}

export interface EditRequest {
  slot: number;
  name: string;
  translator: string;
}

export interface RevertRequest {
  slot: number;
  translator: string;
}

export interface SaveRequest {
  path?: string; // lưu thành file khác
  force?: boolean; // ghi đè dù file trên đĩa đã bị thay đổi
}

export interface SaveResponse {
  file: FileInfo;
  savedCount: number;
  backupPath: string | null;
  logPath: string;
  status: DocStatus;
}

export interface PickResponse {
  path: string | null; // null = người dùng bấm Huỷ
}

export type ErrorCode = "dirty" | "conflict" | "invalid-name";

export interface ErrorResponse {
  error: string;
  code?: ErrorCode;
  issues?: { code: NameIssueCode; severity: "error" | "warning"; message: string }[];
}

export const ENCODING_LABELS: Record<NameEncoding, string> = {
  empty: "Trống",
  "utf-8": "UTF-8",
  unknown: "Không phải UTF-8 (tên gốc Nhật/Hàn?)",
};

export const ISSUE_LABELS: Record<NameIssueCode, string> = {
  "too-long": "Vượt giới hạn 49 byte",
  "control-char": "Có ký tự điều khiển",
  "lone-surrogate": "Ký tự Unicode hỏng",
  "edge-whitespace": "Khoảng trắng đầu/cuối",
  "double-space": "Hai khoảng trắng liền nhau",
};

// Tên nhóm ItemType của MU season 6 (dùng cho cây bên trái).
export const ITEM_TYPE_LABELS: readonly string[] = [
  "Kiếm",
  "Rìu",
  "Chùy / Quyền trượng",
  "Giáo / Thương",
  "Cung / Nỏ",
  "Gậy / Sách phép",
  "Khiên",
  "Mũ",
  "Giáp",
  "Quần",
  "Găng tay",
  "Giày",
  "Cánh / Ngọc / Khác 1",
  "Pet / Nhẫn / Dây chuyền",
  "Bình máu / Ngọc / Khác 3",
  "Sách kỹ năng (Scroll)",
];
