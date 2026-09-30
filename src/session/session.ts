// session.ts - The item data folder being edited (Data/Items of a game folder): translated names,
// per-slot status / note, undo/redo, auto-saved draft, TSV export / import (3-way merge), compare with
// another game folder, reference names, and saving the item files + project.json with backups and a
// change log. Runtime-neutral: all file access goes through a Storage (disk for the desktop build,
// the browser's file APIs for the web build).
//
// Methods that touch files are async and run one at a time (see `exclusive`), so they behave exactly
// like the earlier synchronous version even when requests arrive concurrently.

import {
  AppError,
  ItemData,
  type ItemFileText,
  MAX_ITEM,
  type MergeAnalysis,
  NoItemError,
  type Status,
  type TsvParseResult,
  analyzeImport,
  checkName,
  isItemFileName,
  isSlot,
  nameLength,
  parseTranslationTsv,
  serializeTranslationTsv,
  sha1,
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
  type ImportSource,
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
  backup,
  changeLogPath,
  deleteDraft,
  draftPath,
  parseProject,
  projectPath,
  readDraft,
  readProjectText,
  stamp,
  workDir,
  writeDraft,
  writeProject,
} from "./sidecar";
import { type ItemsFolder, ItemsNotFoundError, type Platform, findItemsFolder } from "./itemsFolder";
import { type Storage, readText, writeText } from "./storage";

export class DirtyError extends AppError {
  constructor(count: number) {
    super("dirty", `${count} unsaved change(s).`, { count });
  }
}

export class ConflictError extends AppError {
  constructor(file: string) {
    super("conflict", `${file} changed on disk after it was opened; overwriting would lose that change.`, { file });
  }
}

export class NoFileError extends AppError {
  constructor() {
    super("no-file", "No game folder is open.");
  }
}

// Everything undo/redo needs to restore one slot.
interface Snap {
  name: string;
  record: SlotRecord | null; // null = default record
}

interface Change {
  slot: number;
  before: Snap;
  after: Snap;
}

const MAX_HISTORY = 500;

const utf8 = new TextDecoder();
const encoder = new TextEncoder();
const textSha1 = (text: string) => sha1(encoder.encode(text));
// Identity of the translated names (merge bases and drafts refer to it).
const namesSha1 = (data: ItemData) => textSha1(JSON.stringify(data.targetNames()));

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
  written: string[];
  backupDir: string | null;
  logPath: string;
}

interface LoadedFolder {
  folder: ItemsFolder;
  data: ItemData;
  shas: Map<string, string>; // file name -> SHA-1 of its bytes as read
  token: string; // SHA-1 over every file (import preview / apply check)
}

export class Session {
  private data: ItemData | null = null;
  private folder: ItemsFolder | null = null;
  private info: FileInfo | null = null;
  private fileShas = new Map<string, string>();
  private diskSha1 = ""; // names on disk (see namesSha1)
  private projectText: string | null = null; // project.json as read / last written (conflict detection)
  private savedRecords = new Map<number, SlotRecord>();
  private records = new Map<number, SlotRecord>();
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private pendingDraft: Draft | null = null;
  private rebased = false;
  private reference: { path: string; names: Map<number, string> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly storage: Storage,
    private readonly now: () => Date = () => new Date(),
    // The OS this runs on: decides which build layout wins when a folder holds several (itemsFolder.ts).
    readonly platform: Platform = "other",
  ) {}

  // Run `fn` after every earlier call has finished (a FIFO lock around state + files).
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get file(): FileInfo | null {
    return this.info;
  }

  get document(): ItemData | null {
    return this.data;
  }

  private doc(): ItemData {
    if (!this.data) throw new NoFileError();
    return this.data;
  }

  // ---- open ----

  // Find the item folder in `picked` and read every item file in it.
  private async load(picked: string): Promise<LoadedFolder> {
    const st = this.storage;
    const folder = await findItemsFolder(st, picked, this.platform);
    const names = (await st.list(folder.dir)).filter(isItemFileName).sort();
    if (!names.length) throw new ItemsNotFoundError(folder.root);
    const files: ItemFileText[] = [];
    const shas = new Map<string, string>();
    for (const name of names) {
      const bytes = await st.read(st.join(folder.dir, name));
      shas.set(name, sha1(bytes));
      files.push({ name, text: utf8.decode(bytes) });
    }
    const token = textSha1([...shas].map(([n, h]) => `${n}:${h}`).join("\n"));
    return { folder, data: ItemData.parse(files), shas, token };
  }

  // `picked` is the game folder (or Data/Items itself). Rejects (ItemsNotFoundError, ItemJsonError,
  // DirtyError...) if it cannot open; the currently open folder is then kept.
  open(picked: string, opts: { discard?: boolean } = {}): Promise<FileInfo> {
    return this.exclusive(async () => {
      const st = this.storage;
      // Read + validate the new folder first: a bad path errors right away instead of a pointless "discard changes?".
      const { folder, data, shas } = await this.load(picked);
      const dirty = this.data ? this.dirtySlots().length : 0;
      if (dirty && !opts.discard) throw new DirtyError(dirty);

      // Discarding the old folder's edits also drops its draft, so it is not offered for restore later.
      if (this.info && dirty) await deleteDraft(st, this.info.path);

      this.data = data;
      this.folder = folder;
      this.fileShas = shas;
      this.diskSha1 = namesSha1(data);
      this.info = this.describe(folder, data);
      this.undoStack = [];
      this.redoStack = [];
      this.pendingDraft = await readDraft(st, folder.dir);
      if (this.pendingDraft && this.pendingDraft.slots.length === 0) this.pendingDraft = null;
      this.reference = null; // the UI sends the reference remembered for this folder again
      await this.loadProject(folder.dir);
      return this.info;
    });
  }

  private async loadProject(abs: string) {
    const st = this.storage;
    this.projectText = await readProjectText(st, abs);
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
    if (project && project.namesSha1 !== this.diskSha1) {
      for (const [slot, r] of this.savedRecords) r.origin = this.nameText(slot);
      this.rebased = this.savedRecords.size > 0;
      try {
        this.projectText = await writeProject(st, abs, this.projectData());
      } catch (e) {
        console.warn(`Could not update project.json: ${(e as Error).message}`);
      }
    }
    this.records = new Map([...this.savedRecords].map(([s, r]) => [s, { ...r }]));
  }

  private projectData(): Project {
    const records: Record<string, SlotRecord> = {};
    for (const [slot, r] of [...this.savedRecords].sort((a, b) => a[0] - b[0])) if (!isDefault(r)) records[slot] = r;
    return { version: 2, namesSha1: this.diskSha1, records };
  }

  private describe(folder: ItemsFolder, data: ItemData): FileInfo {
    const st = this.storage;
    // The item folder relative to the picked folder, e.g. "Data/Items" or "Main.app/Contents/MacOS/Data/Items".
    const parts: string[] = [];
    for (let p = folder.dir; p !== folder.root && parts.length < 8; p = st.dirname(p)) parts.unshift(st.basename(p));
    return {
      path: folder.dir,
      root: folder.root,
      layout: folder.layout,
      fileName: parts.join("/") || st.basename(folder.dir),
      locale: data.locale,
      fileCount: data.fileNames.length,
      itemCount: data.itemCount,
      translatedCount: data.slots().filter((s) => data.originalName(s) !== "").length,
      loadedAt: this.now().toISOString(),
    };
  }

  // ---- read ----

  private nameText(slot: number): string {
    return this.doc().getName(slot);
  }

  record(slot: number): SlotRecord {
    return this.records.get(slot) ?? DEFAULT_RECORD;
  }

  private recordDirty(slot: number): boolean {
    return !sameRecord(this.records.get(slot), this.savedRecords.get(slot));
  }

  dirtySlots(): number[] {
    if (!this.data) return [];
    const set = new Set(this.data.dirtySlots);
    for (const slot of new Set([...this.records.keys(), ...this.savedRecords.keys()])) if (this.recordDirty(slot)) set.add(slot);
    return [...set].sort((a, b) => a - b);
  }

  item(slot: number): ItemTuple {
    const data = this.doc();
    const name = data.getName(slot);
    const issues = name ? checkName(name).issues.map((i) => i.code) : [];
    return [slot, name, data.english(slot), nameLength(name), issues];
  }

  items(): ItemTuple[] {
    if (!this.data) return [];
    const out: ItemTuple[] = new Array(MAX_ITEM);
    for (let slot = 0; slot < MAX_ITEM; slot++) out[slot] = this.item(slot);
    return out;
  }

  editInfo(slot: number): EditInfo | null {
    const data = this.doc();
    if (!data.dirtySlots.includes(slot)) return null;
    const r = this.record(slot);
    return { slot, originalText: data.originalName(slot), translator: r.translator, at: r.updatedAt };
  }

  edits(): EditInfo[] {
    if (!this.data) return [];
    return this.data.dirtySlots.map((s) => this.editInfo(s)!);
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
    return { name: this.doc().getName(slot), record: r ? { ...r } : null };
  }

  private restore(slot: number, s: Snap) {
    this.doc().restoreName(slot, s.name);
    this.setRecord(slot, s.record);
  }

  // Status and notes only make sense for slots that have an item.
  private requireItem(slot: number) {
    if (!isSlot(slot) || !this.doc().exists(slot)) throw new NoItemError(slot);
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
    if (before.name === after.name && sameRecord(before.record, after.record)) return null;
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

  private async commit(changes: Change[]): Promise<MutationResponse> {
    if (changes.length) {
      this.undoStack.push(changes);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      await this.persistDraft();
    }
    return this.response(changes.map((c) => c.slot));
  }

  private slotState(slot: number): SlotState {
    return { item: this.item(slot), edit: this.editInfo(slot), record: this.record(slot), dirty: this.dirtySlots().includes(slot) };
  }

  private response(slots: number[]): MutationResponse {
    return { changed: [...new Set(slots)].map((s) => this.slotState(s)), status: this.status() };
  }

  // Throws NameValidationError for an invalid name, NoItemError for a slot without an item. Editing a
  // name marks the slot "translated"; an empty name removes the translation.
  edit(slot: number, name: string, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      const data = this.doc();
      this.requireItem(slot);
      const change = this.mutate(slot, () => {
        const before = this.nameText(slot);
        data.setName(slot, name);
        if (!data.dirtySlots.includes(slot)) {
          this.setRecord(slot, this.savedRecords.get(slot) ?? null); // typed the original name again = revert
        } else {
          this.setRecord(slot, this.stamped(slot, translator, { status: data.getName(slot) ? "translated" : "untranslated" }, before));
        }
      });
      return this.commit(change ? [change] : []);
    });
  }

  // Back to the saved state: name from the files on disk and the record from project.json.
  revert(slot: number, _translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.requireItem(slot);
      const change = this.mutate(slot, () => {
        this.doc().revert(slot);
        this.setRecord(slot, this.savedRecords.get(slot) ?? null);
      });
      return this.commit(change ? [change] : []);
    });
  }

  setStatus(slots: number[], status: Status, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      const changes: Change[] = [];
      for (const slot of new Set(slots)) {
        if (!isSlot(slot) || !this.doc().exists(slot)) continue;
        if (this.record(slot).status === status) continue;
        const c = this.mutate(slot, () => this.settle(slot, this.stamped(slot, translator, { status }, this.nameText(slot))));
        if (c) changes.push(c);
      }
      return this.commit(changes);
    });
  }

  setNote(slot: number, note: string, translator: string): Promise<MutationResponse> {
    return this.exclusive(async () => {
      const clean = note.replace(/[\t\r\n]+/g, " ").trim();
      this.requireItem(slot);
      if (this.record(slot).note === clean) return this.response([]);
      const change = this.mutate(slot, () => this.settle(slot, this.stamped(slot, translator, { note: clean }, this.nameText(slot))));
      return this.commit(change ? [change] : []);
    });
  }

  undo(): Promise<MutationResponse> {
    return this.exclusive(() => this.step(this.undoStack, this.redoStack, "before"));
  }

  redo(): Promise<MutationResponse> {
    return this.exclusive(() => this.step(this.redoStack, this.undoStack, "after"));
  }

  private async step(from: Change[][], to: Change[][], side: "before" | "after"): Promise<MutationResponse> {
    const group = from.pop();
    if (!group) return this.response([]);
    const ordered = side === "before" ? [...group].reverse() : group;
    for (const c of ordered) this.restore(c.slot, c[side]);
    to.push(group);
    await this.persistDraft();
    return this.response(group.map((c) => c.slot));
  }

  // ---- reference names ----

  // Load names from a TSV / CSV (e.g. the Japanese originals). Not persisted on the server: the UI
  // remembers the path per folder and sends it again after opening. Without one, the English names
  // of the item files serve as the reference.
  setReference(refPath: string | null): Promise<ReferenceInfo | null> {
    return this.exclusive(async () => {
      if (!refPath) {
        this.reference = null;
        return null;
      }
      const st = this.storage;
      const abs = st.resolve(refPath);
      const names = new Map<number, string>();
      // A file with a source column (e.g. MuMain_VI_Item.csv: Nguon = Japanese original) shows that
      // column; otherwise its Name column.
      const parsed = parseTranslationTsv(await readText(st, abs));
      const useRef = parsed.columns.reference && parsed.rows.some((r) => r.reference);
      for (const r of parsed.rows) {
        const name = useRef ? r.reference : r.name;
        if (name) names.set(r.slot, name);
      }
      this.reference = { path: abs, names };
      return { path: abs, fileName: st.basename(abs), entries: [...names].sort((a, b) => a[0] - b[0]) };
    });
  }

  // ---- TSV export / import ----

  exportTsv(target: string, slots: number[]): Promise<ExportResponse> {
    return this.exclusive(async () => {
    const data = this.doc();
    const rows = [...new Set(slots)]
      .filter((s) => isSlot(s) && data.exists(s))
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
          reference: this.reference?.names.get(slot) ?? data.english(slot) ?? "",
          note: r.note,
        };
      });
    const abs = this.storage.resolve(target);
    await writeText(this.storage, abs, serializeTranslationTsv(rows));
    return { path: abs, count: rows.length };
    });
  }

  // Rows of a translation file, or the translated names of another game folder (a plain name list,
  // compared 2-way).
  private async readRows(source: string, kind: ImportSource): Promise<{ path: string; fileName: string; token: string; parsed: TsvParseResult }> {
    const st = this.storage;
    if (kind === "game") {
      const other = await this.load(source);
      const rows = other.data.targetNames().map(([slot, name]) => ({ line: slot + 1, ...typeIndexOf(slot), slot, name }));
      return {
        path: other.folder.root,
        fileName: st.basename(other.folder.root),
        token: other.token,
        parsed: { rows, problems: [], columns: { base: false, status: false, translator: false, note: false, reference: false } },
      };
    }
    const abs = st.resolve(source);
    const bytes = await st.read(abs);
    return { path: abs, fileName: st.basename(abs), token: sha1(bytes), parsed: parseTranslationTsv(utf8.decode(bytes)) };
  }

  private analyze(parsed: TsvParseResult): MergeAnalysis {
    const data = this.doc();
    return analyzeImport(parsed.rows, (slot) => ({ exists: data.exists(slot), name: data.getName(slot), status: this.record(slot).status }));
  }

  previewImport(source: string, kind: ImportSource = "tsv"): Promise<ImportPreview> {
    return this.exclusive(async () => {
      this.doc();
      const { path, fileName, token, parsed } = await this.readRows(source, kind);
      const analysis = this.analyze(parsed);
      return {
        path,
        fileName,
        source: kind,
        token,
        items: analysis.items,
        counts: analysis.counts,
        problems: parsed.problems,
        hasBase: parsed.columns.base,
      };
    });
  }

  // Apply the chosen rows of a previewed file as ONE undoable step.
  applyImport(source: string, token: string, take: number[], translator: string, kind: ImportSource = "tsv"): Promise<MutationResponse> {
    return this.exclusive(async () => {
      const data = this.doc();
      const { fileName, token: now, parsed } = await this.readRows(source, kind);
      if (now !== token) throw new AppError("import-changed", "The file changed since the preview.", { file: fileName });
      const analysis = this.analyze(parsed);
      const rows = new Map(parsed.rows.map((r) => [r.slot, r]));
      const wanted = new Set(take);
      const changes: Change[] = [];

      for (const it of analysis.items) {
        if (!wanted.has(it.slot) || it.kind === "invalid") continue;
        const row = rows.get(it.slot)!;
        const c = this.mutate(it.slot, () => {
          const before = this.nameText(it.slot);
          if (it.kind !== "status") data.setName(it.slot, it.theirs);
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
    });
  }

  // ---- draft ----

  // Apply the draft as one (undoable) step. Names that are no longer valid are skipped.
  restoreDraft(): Promise<MutationResponse & { skipped: number }> {
    return this.exclusive(async () => {
    const draft = this.pendingDraft;
    if (!draft) return { ...this.response([]), skipped: 0 };
    this.pendingDraft = null;
    const data = this.doc();
    const changes: Change[] = [];
    let skipped = 0;
    for (const e of draft.slots) {
      if (!isSlot(e.slot) || !data.exists(e.slot) || (e.name !== undefined && !checkName(e.name).ok)) {
        skipped++;
        continue;
      }
      const c = this.mutate(e.slot, () => {
        if (e.name !== undefined) data.setName(e.slot, e.name);
        if (e.record !== undefined) this.setRecord(e.slot, e.record ? { ...DEFAULT_RECORD, ...e.record } : null);
      });
      if (c) changes.push(c);
    }
    return { ...(await this.commit(changes)), skipped };
    });
  }

  discardDraft(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.info) return;
      this.pendingDraft = null;
      if (this.dirtySlots().length === 0) await deleteDraft(this.storage, this.info.path);
    });
  }

  // Called inside `exclusive`. A failed draft write never fails the edit itself.
  private async persistDraft() {
    const data = this.data;
    const info = this.info;
    const st = this.storage;
    if (!data || !info) return;
    try {
      // An unanswered old draft plus a new edit: archive the old draft under another name instead of overwriting it.
      if (this.pendingDraft) {
        const old = draftPath(st, info.path);
        if (await st.exists(old)) await st.rename(old, st.join(workDir(info.path), `draft-${stamp(this.now())}.json`));
        this.pendingDraft = null;
      }
      const dirty = this.dirtySlots();
      if (!dirty.length) {
        await deleteDraft(st, info.path);
        return;
      }
      const nameDirty = new Set(data.dirtySlots);
      await writeDraft(st, info.path, {
        version: 2,
        baseSha1: this.diskSha1,
        savedAt: this.now().toISOString(),
        slots: dirty.map((slot) => ({
          slot,
          ...(nameDirty.has(slot) ? { name: data.getName(slot) } : {}),
          ...(this.recordDirty(slot) ? { record: this.records.get(slot) ?? null } : {}),
        })),
      });
    } catch (e) {
      console.warn(`Could not write draft: ${(e as Error).message}`);
    }
  }

  // ---- save ----

  save(opts: { force?: boolean } = {}): Promise<SaveResult> {
    return this.exclusive(() => this.saveNow(opts));
  }

  private async saveNow(opts: { force?: boolean }): Promise<SaveResult> {
    const st = this.storage;
    const data = this.doc();
    const info = this.info!;
    const dir = info.path;
    const logPath = changeLogPath(st, dir);
    const dirty = this.dirtySlots();
    if (dirty.length === 0) return { file: info, savedCount: 0, written: [], backupDir: null, logPath };

    const changed = data.changedFiles();
    // Someone / something else wrote an item file we are about to replace, or project.json, since we
    // read them (e.g. Google Drive sync, or MuMain's item editor).
    if (!opts.force) {
      for (const f of changed) {
        const p = st.join(dir, f.name);
        const disk = (await st.exists(p)) ? sha1(await st.read(p)) : null;
        if (disk !== this.fileShas.get(f.name)) throw new ConflictError(f.name);
      }
      if ((await readProjectText(st, dir)) !== this.projectText) throw new ConflictError("project.json");
    }

    // Verify before writing: the new files parse and hold exactly the names we expect.
    const texts = new Map(data.fileNames.map((n) => [n, data.fileText(n)!]));
    for (const f of changed) texts.set(f.name, f.text);
    let check: ItemData;
    try {
      check = ItemData.parse([...texts].map(([name, text]) => ({ name, text })), data.locale);
    } catch (e) {
      throw new AppError("save-verify-failed", `Internal error: output does not parse (${(e as Error).message}) - save aborted.`);
    }
    for (const slot of data.slots()) {
      if (check.getName(slot) !== data.getName(slot) || check.english(slot) !== data.english(slot)) {
        throw new AppError("save-verify-failed", `Internal error: slot ${slot} written incorrectly - save aborted.`, { slot });
      }
    }
    if (check.itemCount !== data.itemCount) throw new AppError("save-verify-failed", "Internal error: item count changed - save aborted.");

    const now = this.now();
    const written: string[] = [];
    for (const f of changed) {
      const p = st.join(dir, f.name);
      await backup(st, dir, now, p);
      const bytes = encoder.encode(f.text);
      await st.writeAtomic(p, bytes);
      this.fileShas.set(f.name, sha1(bytes));
      written.push(p);
    }

    const rows = data.dirtySlots.map((slot) => {
      const r = this.record(slot);
      return {
        at: r.updatedAt || now.toISOString(),
        translator: r.translator,
        ...typeIndexOf(slot),
        oldName: data.originalName(slot),
        newName: data.getName(slot),
      };
    });
    if (rows.length) await appendChangeLog(st, dir, rows);

    // The written files become the new originals; the current records become the saved ones.
    this.data = check;
    this.diskSha1 = namesSha1(check);
    this.savedRecords = new Map([...this.records].map(([s, r]) => [s, { ...r }]));
    await backup(st, dir, now, projectPath(st, dir));
    this.projectText = await writeProject(st, dir, this.projectData());
    await deleteDraft(st, dir);
    this.info = this.describe(this.folder!, check);
    this.pendingDraft = null;
    this.rebased = false;
    // Undo history is kept (undo after save = a new edit).
    return {
      file: this.info,
      savedCount: dirty.length,
      written,
      backupDir: written.length ? st.join(workDir(dir), "backups") : null,
      logPath,
    };
  }
}
