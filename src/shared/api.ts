// api.ts - Kiểu dữ liệu dùng chung giữa server (src/server) và giao diện (web/).
// Chỉ chứa type + hằng số thuần, không import gì từ node/bun.

import type { ErrorCode, ErrorParams } from "../core/errors";
import type { NameEncoding, NameIssue, NameIssueCode } from "../core/nameCodec";

export type { ErrorCode, ErrorParams, NameEncoding, NameIssue, NameIssueCode };

export const LANGS = ["en", "vi"] as const;
export type Lang = (typeof LANGS)[number];
export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

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

export interface PickRequest {
  lang?: Lang; // ngôn ngữ chữ trên hộp thoại của hệ điều hành
}

export interface PickResponse {
  path: string | null; // null = người dùng bấm Huỷ
}

// `error` là câu tiếng Anh (log / dự phòng); giao diện dịch theo `code` + `params`.
export interface ErrorResponse {
  error: string;
  code: ErrorCode;
  params: ErrorParams;
  issues?: NameIssue[];
}
