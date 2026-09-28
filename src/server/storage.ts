// storage.ts - Mọi thao tác ghi đĩa: ghi file an toàn, backup, nhật ký thay đổi, bản nháp.
//
// Dữ liệu phụ nằm trong thư mục "<Item.bmd>.mubmd/" cạnh file:
//   backups/Item-20260928-111300.bmd   bản trước mỗi lần lưu (giữ MAX_BACKUPS bản mới nhất)
//   changes.tsv                        nhật ký: ai đổi tên slot nào, từ gì sang gì
//   draft.json                         thay đổi chưa lưu (tự ghi sau mỗi lần sửa)

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../core";

export const MAX_BACKUPS = 20;

export function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export function workDir(bmdPath: string): string {
  return `${bmdPath}.mubmd`;
}

// 2026-09-28 11:13:00 -> "20260928-111300" (giờ máy)
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class FileLockedError extends AppError {
  constructor(target: string) {
    const file = path.basename(target);
    super("file-locked", `Cannot write ${file}: it is held by another program (is the game client running?).`, { file });
  }
}

// Ghi ra file tạm cùng thư mục rồi đổi tên đè lên: mất điện / lỗi giữa chừng
// không để lại file Item.bmd ghi dở.
export function atomicWrite(target: string, bytes: Uint8Array): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw new FileLockedError(target);
    throw e;
  }
}

// Chép file hiện tại trên đĩa vào backups/ (nếu có) và xoá bớt bản cũ. Trả về đường dẫn backup.
export function backup(target: string, now: Date): string | null {
  if (!fs.existsSync(target)) return null;
  const dir = path.join(workDir(target), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const { name, ext } = path.parse(target);
  let dest = path.join(dir, `${name}-${stamp(now)}${ext}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${name}-${stamp(now)}-${i}${ext}`);
  fs.copyFileSync(target, dest);

  const prefix = `${name}-`;
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort(); // tên chứa thời gian nên sắp theo tên = theo thời gian
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
  return dest;
}

export interface ChangeLogRow {
  at: string;
  translator: string;
  itemType: number;
  itemIndex: number;
  oldName: string;
  newName: string;
}

const LOG_HEADER = "Time\tTranslator\tItemType\tItemIndex\tOldName\tNewName\n";
const cleanCell = (s: string) => s.replace(/[\t\r\n]/g, " ");

export function appendChangeLog(target: string, rows: ChangeLogRow[]): string {
  const dir = workDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "changes.tsv");
  const lines = rows.map((r) =>
    [r.at, cleanCell(r.translator), r.itemType, r.itemIndex, cleanCell(r.oldName), cleanCell(r.newName)].join("\t"),
  );
  const prefix = fs.existsSync(logPath) ? "" : LOG_HEADER;
  fs.appendFileSync(logPath, prefix + lines.map((l) => `${l}\n`).join(""), "utf-8");
  return logPath;
}

export interface DraftEdit {
  slot: number;
  name: string;
  translator: string;
  at: string;
}

export interface Draft {
  version: 1;
  baseSha1: string;
  savedAt: string;
  edits: DraftEdit[];
}

const draftPath = (target: string) => path.join(workDir(target), "draft.json");

export function writeDraft(target: string, draft: Draft): void {
  fs.mkdirSync(workDir(target), { recursive: true });
  atomicWrite(draftPath(target), new TextEncoder().encode(JSON.stringify(draft, null, 1)));
}

// Nháp hỏng / sai định dạng thì coi như không có (không chặn việc mở file).
export function readDraft(target: string): Draft | null {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(target), "utf-8")) as Draft;
    if (d?.version !== 1 || !Array.isArray(d.edits)) return null;
    return d;
  } catch {
    return null;
  }
}

export function deleteDraft(target: string): void {
  fs.rmSync(draftPath(target), { force: true });
}
