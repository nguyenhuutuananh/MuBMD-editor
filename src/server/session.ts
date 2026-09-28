// session.ts - File Item.bmd đang mở trên máy này (mỗi người chạy 1 server riêng):
// chỉnh sửa, undo/redo, bản nháp tự lưu, lưu kèm backup + nhật ký.

import * as fs from "node:fs";
import * as path from "node:path";
import { ItemBmd, MAX_ITEM, checkName, typeIndexOf } from "../core";
import type { DocStatus, DraftInfo, EditInfo, EditMeta, FileInfo, ItemTuple, MutationResponse, SlotState } from "../shared/api";
import {
  type Draft,
  appendChangeLog,
  atomicWrite,
  backup,
  deleteDraft,
  readDraft,
  sha1,
  stamp,
  workDir,
  writeDraft,
} from "./storage";

export class DirtyError extends Error {
  constructor(count: number) {
    super(`Còn ${count} thay đổi chưa lưu.`);
    this.name = "DirtyError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NoFileError extends Error {
  constructor() {
    super("Chưa mở file Item.bmd nào.");
    this.name = "NoFileError";
  }
}

interface Change {
  slot: number;
  before: Uint8Array;
  after: Uint8Array;
  beforeMeta: EditMeta | null;
  afterMeta: EditMeta | null;
}

const MAX_HISTORY = 500;

export interface SaveResult {
  file: FileInfo;
  savedCount: number;
  backupPath: string | null;
  logPath: string;
}

export class Session {
  private bmd: ItemBmd | null = null;
  private info: FileInfo | null = null;
  private diskSha1 = "";
  private meta = new Map<number, EditMeta>();
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private pendingDraft: Draft | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  get file(): FileInfo | null {
    return this.info;
  }

  get document(): ItemBmd | null {
    return this.bmd;
  }

  private doc(): ItemBmd {
    if (!this.bmd) throw new NoFileError();
    return this.bmd;
  }

  // ---- mở file ----

  // Ném lỗi (ENOENT, BmdFormatError, DirtyError...) nếu không mở được; khi đó file đang mở vẫn giữ nguyên.
  open(filePath: string, opts: { discard?: boolean } = {}): FileInfo {
    const abs = path.resolve(filePath);
    if (this.bmd?.isDirty && !opts.discard) throw new DirtyError(this.bmd.dirtySlots.length);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Không phải file: ${abs}`);
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const bmd = ItemBmd.parse(bytes);

    // Bỏ thay đổi của file cũ thì bỏ luôn nháp của nó, để lần sau không bị hỏi khôi phục.
    if (this.info && this.bmd?.isDirty) deleteDraft(this.info.path);

    this.bmd = bmd;
    this.diskSha1 = sha1(bytes);
    this.info = this.describe(abs, bmd, stat.size);
    this.meta.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.pendingDraft = readDraft(abs);
    if (this.pendingDraft && this.pendingDraft.edits.length === 0) this.pendingDraft = null;
    return this.info;
  }

  private describe(abs: string, bmd: ItemBmd, size: number): FileInfo {
    return {
      path: abs,
      fileName: path.basename(abs),
      size,
      checksumValid: bmd.checksumValid,
      namedCount: bmd.entries().length,
      loadedAt: this.now().toISOString(),
    };
  }

  // ---- đọc ----

  item(slot: number): ItemTuple {
    const n = this.doc().getName(slot);
    const issues = n.encoding === "utf-8" ? checkName(n.text).issues.map((i) => i.code) : [];
    return [slot, n.text, n.encoding, n.byteLength, issues];
  }

  items(): ItemTuple[] {
    if (!this.bmd) return [];
    const out: ItemTuple[] = new Array(MAX_ITEM);
    for (let slot = 0; slot < MAX_ITEM; slot++) out[slot] = this.item(slot);
    return out;
  }

  editInfo(slot: number): EditInfo | null {
    const bmd = this.doc();
    if (!bmd.dirtySlots.includes(slot)) return null;
    const orig = bmd.originalName(slot);
    const m = this.meta.get(slot) ?? { translator: "", at: "" };
    return { slot, originalText: orig.text, originalEncoding: orig.encoding, ...m };
  }

  edits(): EditInfo[] {
    if (!this.bmd) return [];
    return this.bmd.dirtySlots.map((s) => this.editInfo(s)!);
  }

  status(): DocStatus {
    return {
      dirtyCount: this.bmd?.dirtySlots.length ?? 0,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  draftInfo(): DraftInfo | null {
    const d = this.pendingDraft;
    if (!d) return null;
    return {
      count: d.edits.length,
      savedAt: d.savedAt,
      translators: [...new Set(d.edits.map((e) => e.translator).filter(Boolean))],
      baseMatches: d.baseSha1 === this.diskSha1,
    };
  }

  // ---- sửa ----

  private apply(slot: number, write: () => void, meta: EditMeta | null): Change | null {
    const bmd = this.doc();
    const before = bmd.getNameBytes(slot);
    const beforeMeta = this.meta.get(slot) ?? null;
    write();
    const after = bmd.getNameBytes(slot);
    if (Buffer.from(before).equals(Buffer.from(after))) return null;
    this.setMeta(slot, meta);
    return { slot, before, after, beforeMeta, afterMeta: this.meta.get(slot) ?? null };
  }

  private setMeta(slot: number, meta: EditMeta | null) {
    if (meta && this.doc().dirtySlots.includes(slot)) this.meta.set(slot, meta);
    else this.meta.delete(slot);
  }

  private commit(changes: Change[]): MutationResponse {
    if (changes.length) {
      this.undoStack.push(changes);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.persistDraft();
    }
    return this.response(changes.map((c) => c.slot));
  }

  private response(slots: number[]): MutationResponse {
    const changed: SlotState[] = [...new Set(slots)].map((s) => ({ item: this.item(s), edit: this.editInfo(s) }));
    return { changed, status: this.status() };
  }

  // Ném NameValidationError nếu tên không hợp lệ.
  edit(slot: number, name: string, translator: string): MutationResponse {
    const bmd = this.doc();
    const change = this.apply(slot, () => bmd.setName(slot, name), { translator, at: this.now().toISOString() });
    return this.commit(change ? [change] : []);
  }

  revert(slot: number, translator: string): MutationResponse {
    const bmd = this.doc();
    const change = this.apply(slot, () => bmd.revert(slot), { translator, at: this.now().toISOString() });
    return this.commit(change ? [change] : []);
  }

  undo(): MutationResponse {
    return this.step(this.undoStack, this.redoStack, "before");
  }

  redo(): MutationResponse {
    return this.step(this.redoStack, this.undoStack, "after");
  }

  private step(from: Change[][], to: Change[][], side: "before" | "after"): MutationResponse {
    const group = from.pop();
    if (!group) return this.response([]);
    const bmd = this.doc();
    const ordered = side === "before" ? [...group].reverse() : group;
    for (const c of ordered) {
      bmd.setNameBytes(c.slot, c[side]);
      this.setMeta(c.slot, side === "before" ? c.beforeMeta : c.afterMeta);
    }
    to.push(group);
    this.persistDraft();
    return this.response(group.map((c) => c.slot));
  }

  // ---- bản nháp ----

  // Áp các thay đổi trong nháp như 1 bước (undo được). Tên không còn hợp lệ thì bỏ qua.
  restoreDraft(): MutationResponse & { skipped: number } {
    const draft = this.pendingDraft;
    if (!draft) return { ...this.response([]), skipped: 0 };
    this.pendingDraft = null;
    const bmd = this.doc();
    const changes: Change[] = [];
    let skipped = 0;
    for (const e of draft.edits) {
      if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot >= MAX_ITEM || !checkName(e.name).ok) {
        skipped++;
        continue;
      }
      const c = this.apply(e.slot, () => bmd.setName(e.slot, e.name), { translator: e.translator ?? "", at: e.at ?? "" });
      if (c) changes.push(c);
    }
    return { ...this.commit(changes), skipped };
  }

  discardDraft(): void {
    if (!this.info) return;
    this.pendingDraft = null;
    if (!this.bmd?.isDirty) deleteDraft(this.info.path);
  }

  private persistDraft() {
    const bmd = this.bmd;
    const info = this.info;
    if (!bmd || !info) return;
    try {
      // Còn nháp cũ chưa trả lời mà đã sửa tiếp: cất nháp cũ sang tên khác thay vì ghi đè mất.
      if (this.pendingDraft) {
        const old = path.join(workDir(info.path), "draft.json");
        if (fs.existsSync(old)) fs.renameSync(old, path.join(workDir(info.path), `draft-${stamp(this.now())}.json`));
        this.pendingDraft = null;
      }
      if (!bmd.isDirty) {
        deleteDraft(info.path);
        return;
      }
      writeDraft(info.path, {
        version: 1,
        baseSha1: this.diskSha1,
        savedAt: this.now().toISOString(),
        edits: bmd.dirtySlots.map((slot) => ({ slot, name: bmd.getName(slot).text, ...(this.meta.get(slot) ?? { translator: "", at: "" }) })),
      });
    } catch (e) {
      console.warn(`Không ghi được bản nháp: ${(e as Error).message}`);
    }
  }

  // ---- lưu ----

  save(opts: { path?: string; force?: boolean } = {}): SaveResult {
    const bmd = this.doc();
    const info = this.info!;
    const target = opts.path ? path.resolve(opts.path) : info.path;
    const sameFile = target === info.path;

    if (sameFile && !opts.force && fs.existsSync(target)) {
      if (sha1(new Uint8Array(fs.readFileSync(target))) !== this.diskSha1) {
        throw new ConflictError(
          "File trên ổ đĩa đã bị thay đổi sau khi bạn mở (Google Drive vừa đồng bộ, hoặc người/chương trình khác đã ghi). " +
            "Ghi đè sẽ làm mất thay đổi đó.",
        );
      }
    }

    const logPath = path.join(workDir(target), "changes.tsv");
    if (sameFile && !bmd.isDirty) return { file: info, savedCount: 0, backupPath: null, logPath };

    const bytes = bmd.toBytes();
    // Kiểm tra lại trước khi ghi: đọc được, checksum đúng, tên khớp.
    const check = ItemBmd.parse(bytes);
    if (!check.checksumValid) throw new Error("Lỗi nội bộ: checksum file sắp ghi không hợp lệ - đã huỷ lưu.");
    for (const slot of bmd.dirtySlots) {
      if (check.getName(slot).text !== bmd.getName(slot).text) throw new Error(`Lỗi nội bộ: slot ${slot} ghi sai - đã huỷ lưu.`);
    }

    const now = this.now();
    const backupPath = backup(target, now);
    atomicWrite(target, bytes);

    const rows = bmd.dirtySlots.map((slot) => {
      const orig = bmd.originalName(slot);
      return {
        at: this.meta.get(slot)?.at || now.toISOString(),
        translator: this.meta.get(slot)?.translator ?? "",
        ...typeIndexOf(slot),
        oldName: orig.encoding === "unknown" ? "(không phải UTF-8)" : orig.text,
        newName: bmd.getName(slot).text,
      };
    });
    if (rows.length) appendChangeLog(target, rows);
    deleteDraft(info.path);

    // File vừa ghi thành file gốc mới. Lịch sử undo giữ nguyên (undo sau khi lưu = sửa tiếp).
    this.bmd = check;
    this.diskSha1 = sha1(bytes);
    this.info = this.describe(target, check, bytes.length);
    this.meta.clear();
    this.pendingDraft = null;
    return { file: this.info, savedCount: rows.length, backupPath, logPath };
  }
}
