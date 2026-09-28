// session.ts - The Item.bmd open on this machine (each translator runs their own server):
// editing names, per-slot status / note, undo/redo, auto-saved draft, TSV export / import (3-way merge),
// reference names, and saving Item.bmd + project.json with backups and a change log.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AppError,
  ItemBmd,
  MAX_ITEM,
  type MergeAnalysis,
  type Status,
  analyzeImport,
  checkName,
  parseTranslationTsv,
  serializeTranslationTsv,
  typeIndexOf,
} from "../core";
import {
  DEFAULT_RECORD,
  type DocStatus,
  type DraftInfo,
  type EditInfo,
  type ExportResponse,
  type FileInfo,
  type ImportPreview,
  type ItemTuple,
  type MutationResponse,
  type ReferenceInfo,
  type SlotRecord,
  type SlotState,
} from "../shared/api";
import {
  type Draft,
  type Project,
  appendChangeLog,
  atomicWrite,
  backup,
  deleteDraft,
  parseProject,
  projectPath,
  readDraft,
  readProjectText,
  sha1,
  stamp,
  workDir,
  writeDraft,
  writeProject,
  writeText,
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

// Everything undo/redo needs to restore one slot.
interface Snap {
  bytes: Uint8Array;
  record: SlotRecord | null; // null = default record
}

interface Change {
  slot: number;
  before: Snap;
  after: Snap;
}

const MAX_HISTORY = 500;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function sameRecord(a: SlotRecord | null | undefined, b: SlotRecord | null | undefined): boolean {
  const x = a ?? DEFAULT_RECORD;
  const y = b ?? DEFAULT_RECORD;
  return (
    x.status === y.status &&
    x.note === y.note &&
    x.translator === y.translator &&
    x.updatedAt === y.updatedAt &&
    (x.origin ?? null) === (y.origin ?? null)
  );
}

const isDefault = (r: SlotRecord) => sameRecord(r, DEFAULT_RECORD);

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
  private projectText: string | null = null; // project.json as read / last written (conflict detection)
  private savedRecords = new Map<number, SlotRecord>();
  private records = new Map<number, SlotRecord>();
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private pendingDraft: Draft | null = null;
  private rebased = false;
  private reference: { path: string; names: Map<number, string> } | null = null;

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
    const dirty = this.bmd ? this.dirtySlots().length : 0;
    if (dirty && !opts.discard) throw new DirtyError(dirty);

    // Discarding the old file's edits also drops its draft, so it is not offered for restore later.
    if (this.info && dirty) deleteDraft(this.info.path);

    this.bmd = bmd;
    this.diskSha1 = sha1(bytes);
    this.info = this.describe(abs, bmd, stat.size);
    this.undoStack = [];
    this.redoStack = [];
    this.pendingDraft = readDraft(abs);
    if (this.pendingDraft && this.pendingDraft.slots.length === 0) this.pendingDraft = null;
    this.reference = null; // the UI sends the reference remembered for this file again
    this.loadProject(abs);
    return this.info;
  }

  private loadProject(abs: string) {
    this.projectText = readProjectText(abs);
    const project = parseProject(this.projectText);
    this.savedRecords = new Map();
    for (const [k, r] of Object.entries(project?.records ?? {})) {
      const slot = Number(k);
      if (Number.isInteger(slot) && slot >= 0 && slot < MAX_ITEM && r && typeof r === "object") {
        this.savedRecords.set(slot, { ...DEFAULT_RECORD, ...r });
      }
    }
    // The file was replaced from outside since our last save (e.g. a new master copy): the names we
    // started from are gone, so every merge base becomes the current name. Persisted right away so
    // this happens (and is reported) once.
    this.rebased = false;
    if (project && project.bmdSha1 !== this.diskSha1) {
      for (const [slot, r] of this.savedRecords) r.origin = this.nameText(slot);
      this.rebased = this.savedRecords.size > 0;
      try {
        this.projectText = writeProject(abs, this.projectData());
      } catch (e) {
        console.warn(`Could not update project.json: ${(e as Error).message}`);
      }
    }
    this.records = new Map([...this.savedRecords].map(([s, r]) => [s, { ...r }]));
  }

  private projectData(): Project {
    const records: Record<string, SlotRecord> = {};
    for (const [slot, r] of [...this.savedRecords].sort((a, b) => a[0] - b[0])) if (!isDefault(r)) records[slot] = r;
    return { version: 1, bmdSha1: this.diskSha1, records };
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

  private nameText(slot: number): string {
    const n = this.doc().getName(slot);
    return n.encoding === "unknown" ? "" : n.text;
  }

  record(slot: number): SlotRecord {
    return this.records.get(slot) ?? DEFAULT_RECORD;
  }

  private recordDirty(slot: number): boolean {
    return !sameRecord(this.records.get(slot), this.savedRecords.get(slot));
  }

  dirtySlots(): number[] {
    if (!this.bmd) return [];
    const set = new Set(this.bmd.dirtySlots);
    for (const slot of new Set([...this.records.keys(), ...this.savedRecords.keys()])) if (this.recordDirty(slot)) set.add(slot);
    return [...set].sort((a, b) => a - b);
  }

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
    const r = this.record(slot);
    return { slot, originalText: orig.text, originalEncoding: orig.encoding, translator: r.translator, at: r.updatedAt };
  }

  edits(): EditInfo[] {
    if (!this.bmd) return [];
    return this.bmd.dirtySlots.map((s) => this.editInfo(s)!);
  }

  recordList(): [number, SlotRecord][] {
    return [...this.records].filter(([, r]) => !isDefault(r)).sort((a, b) => a[0] - b[0]);
  }

  wasRebased(): boolean {
    return this.rebased;
  }

  status(): DocStatus {
    return {
      dirtyCount: this.dirtySlots().length,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  draftInfo(): DraftInfo | null {
    const d = this.pendingDraft;
    if (!d) return null;
    return {
      count: d.slots.length,
      savedAt: d.savedAt,
      translators: [...new Set(d.slots.map((e) => e.record?.translator ?? "").filter(Boolean))],
      baseMatches: d.baseSha1 === this.diskSha1,
    };
  }

  // ---- edit ----

  private snap(slot: number): Snap {
    const r = this.records.get(slot);
    return { bytes: this.doc().getNameBytes(slot), record: r ? { ...r } : null };
  }

  private restore(slot: number, s: Snap) {
    this.doc().setNameBytes(slot, s.bytes);
    this.setRecord(slot, s.record);
  }

  private setRecord(slot: number, r: SlotRecord | null) {
    if (r && !isDefault(r)) this.records.set(slot, { ...r });
    else this.records.delete(slot);
  }

  // Run `fn` on one slot and return the change for undo, or null if nothing changed.
  private mutate(slot: number, fn: () => void): Change | null {
    const before = this.snap(slot);
    fn();
    const after = this.snap(slot);
    if (sameBytes(before.bytes, after.bytes) && sameRecord(before.record, after.record)) return null;
    return { slot, before, after };
  }

  // A change that brings name + status + note back to the saved state restores the saved record
  // exactly, so the slot is no longer dirty (instead of differing only by "updatedAt").
  private settle(slot: number, next: SlotRecord) {
    const saved = this.savedRecords.get(slot) ?? DEFAULT_RECORD;
    const nameClean = !this.doc().dirtySlots.includes(slot);
    if (nameClean && next.status === saved.status && next.note === saved.note) this.setRecord(slot, saved);
    else this.setRecord(slot, next);
  }

  private stamped(slot: number, translator: string, patch: Partial<SlotRecord>, originName: string): SlotRecord {
    const cur = this.record(slot);
    return { ...cur, translator, updatedAt: this.now().toISOString(), origin: cur.origin ?? originName, ...patch };
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

  private slotState(slot: number): SlotState {
    return { item: this.item(slot), edit: this.editInfo(slot), record: this.record(slot), dirty: this.dirtySlots().includes(slot) };
  }

  private response(slots: number[]): MutationResponse {
    return { changed: [...new Set(slots)].map((s) => this.slotState(s)), status: this.status() };
  }

  // Throws NameValidationError for an invalid name. Editing a name marks the slot "translated".
  edit(slot: number, name: string, translator: string): MutationResponse {
    const bmd = this.doc();
    const change = this.mutate(slot, () => {
      const before = this.nameText(slot);
      bmd.setName(slot, name);
      if (sameBytes(bmd.getNameBytes(slot), bmd.originalNameBytes(slot))) {
        this.setRecord(slot, this.savedRecords.get(slot) ?? null); // typed the original name again = revert
      } else {
        this.setRecord(slot, this.stamped(slot, translator, { status: "translated" }, before));
      }
    });
    return this.commit(change ? [change] : []);
  }

  // Back to the saved state: name from the file on disk and the record from project.json.
  revert(slot: number, _translator: string): MutationResponse {
    const change = this.mutate(slot, () => {
      this.doc().revert(slot);
      this.setRecord(slot, this.savedRecords.get(slot) ?? null);
    });
    return this.commit(change ? [change] : []);
  }

  setStatus(slots: number[], status: Status, translator: string): MutationResponse {
    const changes: Change[] = [];
    for (const slot of new Set(slots)) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ITEM) continue;
      if (this.record(slot).status === status) continue;
      const c = this.mutate(slot, () => this.settle(slot, this.stamped(slot, translator, { status }, this.nameText(slot))));
      if (c) changes.push(c);
    }
    return this.commit(changes);
  }

  setNote(slot: number, note: string, translator: string): MutationResponse {
    const clean = note.replace(/[\t\r\n]+/g, " ").trim();
    this.doc().getName(slot); // validates the slot
    if (this.record(slot).note === clean) return this.response([]);
    const change = this.mutate(slot, () => this.settle(slot, this.stamped(slot, translator, { note: clean }, this.nameText(slot))));
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
    const ordered = side === "before" ? [...group].reverse() : group;
    for (const c of ordered) this.restore(c.slot, c[side]);
    to.push(group);
    this.persistDraft();
    return this.response(group.map((c) => c.slot));
  }

  // ---- reference names ----

  // Load names from another Item.bmd (e.g. the original English/Korean file) or a TSV. Not persisted
  // on the server: the UI remembers the path per file and sends it again after opening.
  setReference(refPath: string | null): ReferenceInfo | null {
    if (!refPath) {
      this.reference = null;
      return null;
    }
    const abs = path.resolve(refPath);
    const names = new Map<number, string>();
    if (abs.toLowerCase().endsWith(".bmd")) {
      const ref = ItemBmd.parse(new Uint8Array(fs.readFileSync(abs)));
      for (const e of ref.entries()) if (e.encoding === "utf-8") names.set(e.slot, e.text);
    } else {
      // A file with a source column (e.g. MuMain_VI_Item.csv: Nguon = Japanese original) shows that
      // column; otherwise its Name column.
      const parsed = parseTranslationTsv(fs.readFileSync(abs, "utf-8"));
      const useRef = parsed.columns.reference && parsed.rows.some((r) => r.reference);
      for (const r of parsed.rows) {
        const name = useRef ? r.reference : r.name;
        if (name) names.set(r.slot, name);
      }
    }
    this.reference = { path: abs, names };
    return { path: abs, fileName: path.basename(abs), entries: [...names].sort((a, b) => a[0] - b[0]) };
  }

  // ---- TSV export / import ----

  exportTsv(target: string, slots: number[]): ExportResponse {
    const bmd = this.doc();
    const rows = [...new Set(slots)]
      .filter((s) => Number.isInteger(s) && s >= 0 && s < MAX_ITEM && bmd.getName(s).encoding !== "unknown")
      .sort((a, b) => a - b)
      .map((slot) => {
        const r = this.record(slot);
        const name = this.nameText(slot);
        return {
          ...typeIndexOf(slot),
          name,
          status: r.status,
          translator: r.translator,
          updatedAt: r.updatedAt,
          base: r.origin ?? name,
          reference: this.reference?.names.get(slot) ?? "",
          note: r.note,
        };
      });
    const abs = path.resolve(target);
    writeText(abs, serializeTranslationTsv(rows));
    return { path: abs, count: rows.length };
  }

  // Rows of a translation file; another Item.bmd is read as a plain name list (2-way compare).
  private readRows(bytes: Uint8Array, isBmd: boolean): ReturnType<typeof parseTranslationTsv> {
    if (!isBmd) return parseTranslationTsv(new TextDecoder().decode(bytes));
    const other = ItemBmd.parse(bytes);
    const rows = other
      .entries()
      .filter((e) => e.encoding === "utf-8")
      .map((e) => ({ line: e.slot + 1, itemType: e.itemType, itemIndex: e.itemIndex, slot: e.slot, name: e.text }));
    return { rows, problems: [], columns: { base: false, status: false, translator: false, note: false, reference: false } };
  }

  private analyze(parsed: ReturnType<typeof parseTranslationTsv>): { analysis: MergeAnalysis; parsed: ReturnType<typeof parseTranslationTsv> } {
    const bmd = this.doc();
    const analysis = analyzeImport(parsed.rows, (slot) => {
      const n = bmd.getName(slot);
      return { name: n.text, encoding: n.encoding, status: this.record(slot).status };
    });
    return { analysis, parsed };
  }

  previewImport(source: string): ImportPreview {
    this.doc();
    const abs = path.resolve(source);
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const isBmd = abs.toLowerCase().endsWith(".bmd");
    const { analysis, parsed } = this.analyze(this.readRows(bytes, isBmd));
    return {
      path: abs,
      fileName: path.basename(abs),
      source: isBmd ? "bmd" : "tsv",
      token: sha1(bytes),
      items: analysis.items,
      counts: analysis.counts,
      problems: parsed.problems,
      hasBase: parsed.columns.base,
    };
  }

  // Apply the chosen rows of a previewed file as ONE undoable step.
  applyImport(source: string, token: string, take: number[], translator: string): MutationResponse {
    const bmd = this.doc();
    const abs = path.resolve(source);
    const bytes = new Uint8Array(fs.readFileSync(abs));
    if (sha1(bytes) !== token) throw new AppError("import-changed", "The file changed since the preview.", { file: path.basename(abs) });
    const { analysis, parsed } = this.analyze(this.readRows(bytes, abs.toLowerCase().endsWith(".bmd")));
    const rows = new Map(parsed.rows.map((r) => [r.slot, r]));
    const wanted = new Set(take);
    const changes: Change[] = [];

    for (const it of analysis.items) {
      if (!wanted.has(it.slot) || it.kind === "invalid") continue;
      const row = rows.get(it.slot)!;
      const c = this.mutate(it.slot, () => {
        const before = this.nameText(it.slot);
        if (it.kind !== "status") bmd.setName(it.slot, it.theirs);
        const cur = this.record(it.slot);
        this.setRecord(it.slot, {
          ...cur,
          status: row.status ?? (it.kind === "status" ? cur.status : "translated"),
          translator: row.translator || translator,
          updatedAt: row.updatedAt || this.now().toISOString(),
          note: row.note ? row.note : cur.note,
          origin: cur.origin ?? before,
        });
      });
      if (c) changes.push(c);
    }
    return this.commit(changes);
  }

  // ---- draft ----

  // Apply the draft as one (undoable) step. Names that are no longer valid are skipped.
  restoreDraft(): MutationResponse & { skipped: number } {
    const draft = this.pendingDraft;
    if (!draft) return { ...this.response([]), skipped: 0 };
    this.pendingDraft = null;
    const bmd = this.doc();
    const changes: Change[] = [];
    let skipped = 0;
    for (const e of draft.slots) {
      if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot >= MAX_ITEM || (e.name !== undefined && !checkName(e.name).ok)) {
        skipped++;
        continue;
      }
      const c = this.mutate(e.slot, () => {
        if (e.name !== undefined) bmd.setName(e.slot, e.name);
        if (e.record !== undefined) this.setRecord(e.slot, e.record ? { ...DEFAULT_RECORD, ...e.record } : null);
      });
      if (c) changes.push(c);
    }
    return { ...this.commit(changes), skipped };
  }

  discardDraft(): void {
    if (!this.info) return;
    this.pendingDraft = null;
    if (this.dirtySlots().length === 0) deleteDraft(this.info.path);
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
      const dirty = this.dirtySlots();
      if (!dirty.length) {
        deleteDraft(info.path);
        return;
      }
      const nameDirty = new Set(bmd.dirtySlots);
      writeDraft(info.path, {
        version: 2,
        baseSha1: this.diskSha1,
        savedAt: this.now().toISOString(),
        slots: dirty.map((slot) => ({
          slot,
          ...(nameDirty.has(slot) ? { name: bmd.getName(slot).text } : {}),
          ...(this.recordDirty(slot) ? { record: this.records.get(slot) ?? null } : {}),
        })),
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

    // Someone / something else wrote Item.bmd or project.json since we read them (e.g. Google Drive sync).
    if (sameFile && !opts.force) {
      const diskBmd = fs.existsSync(target) ? sha1(new Uint8Array(fs.readFileSync(target))) : this.diskSha1;
      if (diskBmd !== this.diskSha1 || readProjectText(target) !== this.projectText) throw new ConflictError();
    }

    const logPath = path.join(workDir(target), "changes.tsv");
    const dirty = this.dirtySlots();
    if (sameFile && dirty.length === 0) return { file: info, savedCount: 0, backupPath: null, logPath };

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
    let backupPath: string | null = null;
    if (bmd.isDirty || !sameFile) {
      backupPath = backup(target, now);
      atomicWrite(target, bytes);
    }

    const rows = bmd.dirtySlots.map((slot) => {
      const orig = bmd.originalName(slot);
      const r = this.record(slot);
      return {
        at: r.updatedAt || now.toISOString(),
        translator: r.translator,
        ...typeIndexOf(slot),
        oldName: orig.encoding === "unknown" ? "(non-UTF-8)" : orig.text,
        newName: bmd.getName(slot).text,
      };
    });
    if (rows.length) appendChangeLog(target, rows);

    // The written file becomes the new original; the current records become the saved ones.
    this.bmd = check;
    this.diskSha1 = sha1(bytes);
    this.savedRecords = new Map([...this.records].map(([s, r]) => [s, { ...r }]));
    backup(target, now, projectPath(target));
    this.projectText = writeProject(target, this.projectData());
    deleteDraft(info.path);
    this.info = this.describe(target, check, bytes.length);
    this.pendingDraft = null;
    this.rebased = false;
    // Undo history is kept (undo after save = a new edit).
    return { file: this.info, savedCount: dirty.length, backupPath, logPath };
  }
}
