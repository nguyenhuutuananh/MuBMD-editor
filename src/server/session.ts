// session.ts - The Item.bmd open on this machine (each translator runs their own server):
// editing, undo/redo, auto-saved draft, saving with backup + change log.

import * as fs from "node:fs";
import * as path from "node:path";
import { AppError, ItemBmd, MAX_ITEM, checkName, typeIndexOf } from "../core";
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

export class DirtyError extends AppError {
  constructor(count: number) {
    super("dirty", `${count} unsaved change(s).`, { count });
  }
}

export class ConflictError extends AppError {
  constructor() {
    super("conflict", "The file on disk changed after it was opened; overwriting would lose that change.");
  }
}

export class NoFileError extends AppError {
  constructor() {
    super("no-file", "No Item.bmd file is open.");
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

  // ---- open ----

  // Throws (ENOENT, BmdFormatError, DirtyError...) if it cannot open; the currently open file is then kept.
  open(filePath: string, opts: { discard?: boolean } = {}): FileInfo {
    const abs = path.resolve(filePath);
    // Read + validate the new file first: a bad path errors right away instead of a pointless "discard changes?".
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new AppError("not-a-file", `Not a file: ${abs}`, { path: abs });
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const bmd = ItemBmd.parse(bytes);
    if (this.bmd?.isDirty && !opts.discard) throw new DirtyError(this.bmd.dirtySlots.length);

    // Discarding the old file's edits also drops its draft, so it is not offered for restore later.
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

  // ---- read ----

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

  // ---- edit ----

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

  // Throws NameValidationError for an invalid name.
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

  // ---- draft ----

  // Apply the draft's edits as one (undoable) step. Names that are no longer valid are skipped.
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
      // An unanswered old draft plus a new edit: archive the old draft under another name instead of overwriting it.
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
      console.warn(`Could not write draft: ${(e as Error).message}`);
    }
  }

  // ---- save ----

  save(opts: { path?: string; force?: boolean } = {}): SaveResult {
    const bmd = this.doc();
    const info = this.info!;
    const target = opts.path ? path.resolve(opts.path) : info.path;
    const sameFile = target === info.path;

    if (sameFile && !opts.force && fs.existsSync(target)) {
      if (sha1(new Uint8Array(fs.readFileSync(target))) !== this.diskSha1) {
        throw new ConflictError();
      }
    }

    const logPath = path.join(workDir(target), "changes.tsv");
    if (sameFile && !bmd.isDirty) return { file: info, savedCount: 0, backupPath: null, logPath };

    const bytes = bmd.toBytes();
    // Verify before writing: parses, checksum valid, names match.
    const check = ItemBmd.parse(bytes);
    if (!check.checksumValid) throw new AppError("save-verify-failed", "Internal error: checksum of output is invalid - save aborted.");
    for (const slot of bmd.dirtySlots) {
      if (check.getName(slot).text !== bmd.getName(slot).text) {
        throw new AppError("save-verify-failed", `Internal error: slot ${slot} written incorrectly - save aborted.`, { slot });
      }
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
        oldName: orig.encoding === "unknown" ? "(non-UTF-8)" : orig.text,
        newName: bmd.getName(slot).text,
      };
    });
    if (rows.length) appendChangeLog(target, rows);
    deleteDraft(info.path);

    // The written file becomes the new original. Undo history is kept (undo after save = a new edit).
    this.bmd = check;
    this.diskSha1 = sha1(bytes);
    this.info = this.describe(target, check, bytes.length);
    this.meta.clear();
    this.pendingDraft = null;
    return { file: this.info, savedCount: rows.length, backupPath, logPath };
  }
}
