// session.ts - The workspace being translated: MuMain's Localization string tables and / or its item
// names (see workspace.ts), one target locale (vi, de...) against en, with an optional reference
// locale; editing with undo/redo, an auto-saved draft, and saving with backups + a change log
// (sidecar.ts); per-key status / note in .mumain-translator/project-<locale>.json; TSV export /
// import with a 3-way merge. Runtime-neutral: all file access goes through a Storage (disk for the
// desktop build, the browser's file APIs for the web build).
//
// Everything is per key of a group. Each group (a <Group> of .resx files, or one Data/Items file)
// is a SourceGroup that knows its format (sources/); here a key is either absent (the game shows
// English) or a text + comment, and may have a record (status, note, who, merge base). Undo, the
// draft and "reload keeping my edits" all work on those key states, so they survive a file changing
// on disk (git pull, Drive sync) as long as the same key was not changed there too. Keys are
// identified by group NAME + key, so they stay valid when the workspace is read again.
//
// Methods that touch files are async and run one at a time (see `exclusive`), so concurrent
// requests cannot interleave.

import {
  AppError,
  DEFAULT_LOCALE,
  type Decision,
  type Issue,
  type ProposalItem,
  type Status,
  analyzeImport,
  buildPackage,
  checkEmitter,
  checkLocaleCode,
  checkOptionWindow,
  ITEM_TAB,
  SHEET_TAIL,
  type TsvParseResult,
  isZip,
  languageName,
  parseGlossary,
  parseTranslationTsv,
  readPackage,
  serializeCsv,
  serializeGlossary,
  serializeTranslationTsv,
  sha1,
  sheetFileName,
  sheetTab,
  toIdentifier,
  unzip,
  zip,
  type ReadPackage,
} from "../core";
import {
  type DecideResponse,
  type DocStatus,
  type DraftInfo,
  type ExportPackageResponse,
  type ExportResponse,
  type ExportSheetsResponse,
  type GroupInfo,
  type ImportPreview,
  type KeyRecord,
  type KeyRef,
  type MutationResponse,
  type OpenInfo,
  type PackageInfo,
  type ProposalDecision,
  type ProposalRow,
  type ProposalState,
  type ProposalsResponse,
  type RebaseResponse,
  type RegistrationFile,
  type RegistrationInfo,
  ROW_DIRTY,
  ROW_KEEP,
  type RowIssue,
  type RowTuple,
  type RowsResponse,
  type WorkspaceListing,
} from "../shared/api";
import { localeLabel } from "../shared/locales";
import { writeLocaleName } from "./localeNames";
import type { Platform } from "./itemsFolder";
import { migrateLegacy } from "./migrate";
import { type LoadedProposal, type ProposalScan, loadProposals, recordDecisions } from "./proposals";
import {
  SIDECAR_DIR,
  type Draft,
  type EntryState,
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
import { loadItemsGroups } from "./sources/itemsGroup";
import { loadResxGroups } from "./sources/resxGroup";
import type { SourceGroup, WritePlan } from "./sources/types";
import { type Storage, tryReadText, writeText } from "./storage";
import { type Workspace, findWorkspace, listWorkspace } from "./workspace";

// The two hand-written locale lists of MuMain, relative to src/Localization.
export const OPTION_WINDOW_FILE = "../source/UI/NewUI/Options/NewUIOptionWindow.cpp";
export const EMITTER_FILE = "../../tools/ResxGen/CppEmitter.cs";

export class NoFolderError extends AppError {
  constructor() {
    super("no-folder", "No folder is open.");
  }
}

export class DirtyError extends AppError {
  constructor(count: number) {
    super("dirty", `${count} unsaved change(s).`, { count });
  }
}

export class ConflictError extends AppError {
  constructor(readonly files: string[]) {
    super("conflict", `Changed on disk since they were read: ${files.join(", ")}.`, { files: files.join(", ") });
  }
}

// Everything undo / the draft need to restore one key.
interface KeyState {
  entry: EntryState;
  record: KeyRecord | null;
}

interface Change {
  group: string;
  key: string;
  before: KeyState;
  after: KeyState;
}

export interface SaveResult {
  files: string[];
  created: string[];
  savedCount: number;
  backups: string[];
  logPath: string;
}

const MAX_HISTORY = 500;
const id = (group: string, key: string) => `${group}\u0000${key}`;
function splitId(k: string): [string, string] {
  const i = k.indexOf("\u0000");
  return [k.slice(0, i), k.slice(i + 1)];
}

const sameState = (a: EntryState, b: EntryState) => a === b || (a !== null && b !== null && a.value === b.value && a.comment === b.comment);
const sameRecord = (a: KeyRecord | null, b: KeyRecord | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.status === b.status &&
    a.note === b.note &&
    a.translator === b.translator &&
    a.updatedAt === b.updatedAt &&
    (a.origin ?? null) === (b.origin ?? null));
const sameKeyState = (a: KeyState, b: KeyState) => sameState(a.entry, b.entry) && sameRecord(a.record, b.record);
const oneLine = (s: unknown) => (typeof s === "string" ? s.replace(/[\t\r\n]+/g, " ").trim() : "");

// What a proposed text would be checked as (for writers of proposals: the MCP server), with the
// English text and the translation it is made from.
export interface ProposalInfo {
  state: ProposalState;
  issues: RowIssue[];
  english: string | null; // null: not a key of the English source
  base: string; // the translation now ("" = none)
  status: Status | null;
}

// The newest undecided proposal of a key, and the older undecided ones of the same key.
interface PendingProposal {
  p: LoadedProposal;
  index: number;
  older: { p: LoadedProposal; index: number }[];
}

export class Session {
  private info: OpenInfo | null = null;
  private workspace: Workspace | null = null;
  private groups: SourceGroup[] = [];
  private records = new Map<string, KeyRecord>(); // current, by id
  private savedRecords = new Map<string, KeyRecord>(); // as in project-<locale>.json
  private projectText: string | null = null; // the project file as read / last written (conflict detection)
  private touched = new Set<string>(); // keys changed since the last save (dirty or changed back)
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private pendingDraft: Draft | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly storage: Storage,
    private readonly now: () => Date = () => new Date(),
    // The OS this runs on: decides which game layout wins when a folder holds several (itemsFolder.ts).
    readonly platform: Platform = "other",
  ) {}

  // Run `fn` after every earlier call has finished (a FIFO lock around state + files).
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get open(): OpenInfo | null {
    return this.info;
  }

  // ---- open ----

  // What a folder holds, without opening it (for choosing the locale).
  scan(path: string): Promise<WorkspaceListing> {
    return this.exclusive(async () => (await this.readListing(path)).listing);
  }

  private async readListing(path: string): Promise<{ ws: Workspace; listing: WorkspaceListing }> {
    const ws = await findWorkspace(this.storage, path, this.platform);
    const listing = await listWorkspace(this.storage, ws);
    if (ws.resx && !ws.items && !listing.resx!.groups.some((g) => g.hasDefault)) {
      throw new AppError("no-default", `No <Group>.${DEFAULT_LOCALE}.resx file in ${ws.resx.dir}.`, { path: ws.resx.dir });
    }
    return { ws, listing };
  }

  // Opens `path` for translating `locale`. Every file is read before anything changes, so a
  // broken file leaves the previously open workspace as it was. Unsaved edits of the open one
  // block this unless `discard` (then their draft is deleted too). `create` accepts a locale the
  // workspace has no translation for yet: nothing is written until the first save.
  openFolder(
    path: string,
    locale: string,
    reference: string | null = null,
    opts: { discard?: boolean; create?: boolean; name?: string } = {},
  ): Promise<OpenInfo> {
    return this.exclusive(async () => {
      const { ws, listing } = await this.readListing(path);
      const exists = listing.locales.some((l) => l.code === locale);
      if (opts.create && !exists) checkLocaleCode(locale);
      if (locale === DEFAULT_LOCALE || (!exists && !opts.create)) {
        throw new AppError("locale-not-found", `There is no ${locale} translation in ${path}.`, { locale, path });
      }
      const ref = reference && reference !== locale && reference !== DEFAULT_LOCALE ? reference : null;
      const groups = await this.loadGroups(ws, locale, ref);
      const dirty = this.dirtyIds().length;
      if (dirty && !opts.discard) throw new DirtyError(dirty);
      if (dirty && this.info) await deleteDraft(this.storage, this.info.folder.path, this.info.locale);

      this.workspace = ws;
      this.groups = groups;
      // The first open of this locale: carry over what MuResx-editor / MuBMD-editor kept.
      let migrated = null;
      try {
        migrated = await migrateLegacy(this.storage, ws, listing.path, locale, groups, this.now());
      } catch (e) {
        console.warn(`Could not carry over the old side data: ${(e as Error).message}`);
      }
      // A name given for the locale (a new one, or renamed) is kept for this folder.
      if (opts.name !== undefined) {
        try {
          listing.names = await writeLocaleName(this.storage, listing.path, locale, opts.name);
        } catch (e) {
          console.warn(`Could not store the locale name: ${(e as Error).message}`);
        }
      }
      this.info = { folder: listing, locale, reference: ref, loadedAt: this.now().toISOString(), migrated };
      await this.loadProject();
      this.records = new Map(this.savedRecords);
      this.touched.clear();
      this.undoStack = [];
      this.redoStack = [];
      this.pendingDraft = await readDraft(this.storage, listing.path, locale);
      return this.info;
    });
  }

  private async loadGroups(ws: Workspace, locale: string, ref: string | null): Promise<SourceGroup[]> {
    const out: SourceGroup[] = [];
    if (ws.resx) out.push(...(await loadResxGroups(this.storage, ws.resx.dir, ws.resx.rel, locale, ref)));
    if (ws.items) out.push(...(await loadItemsGroups(this.storage, ws.items.dir, ws.items.rel, locale, ref)));
    return out;
  }

  // Reads project-<locale>.json into savedRecords. A group whose translations changed from outside
  // since the project was written (git pull, a new master copy) gets its merge bases reset to what is
  // on disk now; that is written back right away so it happens (and is reported) once. Returns the
  // names of those groups.
  private async loadProject(): Promise<string[]> {
    const { folder, locale } = this.folderInfo();
    const st = this.storage;
    this.projectText = await readProjectText(st, folder.path, locale);
    const project = parseProject(this.projectText, locale);
    this.savedRecords = new Map();
    for (const [group, keys] of Object.entries(project?.records ?? {})) {
      for (const [key, r] of Object.entries(keys)) this.savedRecords.set(id(group, key), r);
    }
    const reset: string[] = [];
    if (!project) return reset;
    for (const g of this.groups) {
      const known = project.bases[g.name];
      if (known === undefined || known === g.baseHash()) continue;
      reset.push(g.name);
      for (const [k, r] of this.savedRecords) {
        const [group, key] = splitId(k);
        if (group === g.name) this.savedRecords.set(k, { ...r, origin: g.saved(key)?.value ?? "" });
      }
    }
    if (reset.length) {
      try {
        this.projectText = await writeProject(st, folder.path, this.projectData());
      } catch (e) {
        console.warn(`Could not update ${projectPath(st, folder.path, locale)}: ${(e as Error).message}`);
      }
    }
    return reset;
  }

  private projectData(): Project {
    const { locale } = this.folderInfo();
    const bases: Record<string, string> = {};
    for (const g of this.groups) if (g.targetFile) bases[g.name] = g.baseHash();
    const records: Project["records"] = {};
    for (const [k, r] of [...this.savedRecords].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const [group, key] = splitId(k);
      (records[group] ??= {})[key] = r;
    }
    return { version: 1, locale, bases, records };
  }

  setReference(locale: string | null): Promise<OpenInfo> {
    return this.exclusive(async () => {
      const info = this.folderInfo();
      const ref = locale && locale !== info.locale && locale !== DEFAULT_LOCALE ? locale : null;
      if (ref && !info.folder.locales.some((l) => l.code === ref)) {
        throw new AppError("locale-not-found", `There is no ${ref} translation in ${info.folder.path}.`, { locale: ref, path: info.folder.path });
      }
      for (const g of this.groups) await g.setReference(ref);
      this.info = { ...info, reference: ref };
      return this.info;
    });
  }

  // Whether the game's option window and ResxGen know the open locale (read only; see registration.ts).
  // Needs the Localization folder of a checkout (the files are next to it).
  registration(): Promise<RegistrationInfo> {
    return this.exclusive(async () => {
      const { locale } = this.folderInfo();
      const resxDir = this.workspace?.resx?.dir ?? null;
      const name = localeLabel(locale, this.info?.folder.names);
      const read = async (rel: string, check: typeof checkOptionWindow): Promise<RegistrationFile | null> => {
        if (!resxDir) return null;
        const text = await tryReadText(this.storage, this.storage.join(resxDir, rel));
        if (text === null) return null;
        const c = check(text, locale, name);
        // A file without any entry is not the file we think it is.
        return c.codes.length ? { path: rel, registered: c.registered, line: c.line, after: c.after } : null;
      };
      return { locale, name, optionWindow: await read(OPTION_WINDOW_FILE, checkOptionWindow), emitter: await read(EMITTER_FILE, checkEmitter) };
    });
  }

  private folderInfo(): OpenInfo {
    if (!this.info) throw new NoFolderError();
    return this.info;
  }

  // ---- key state ----

  private group(name: string): SourceGroup {
    const g = this.groups.find((x) => x.name === name);
    if (!g) throw new AppError("not-editable", `No group named ${name}.`, { group: name });
    return g;
  }

  private keyState(g: SourceGroup, key: string): KeyState {
    return { entry: g.current(key), record: this.records.get(id(g.name, key)) ?? null };
  }

  private savedState(g: SourceGroup, key: string): KeyState {
    return { entry: g.saved(key), record: this.savedRecords.get(id(g.name, key)) ?? null };
  }

  // The record's status, else what the text says: none / identical to en = untranslated.
  private statusOf(g: SourceGroup, key: string, s: KeyState): Status {
    if (s.record) return s.record.status;
    if (!s.entry) return "untranslated";
    if (g.isKeep(s.entry)) return "translated";
    return s.entry.value === g.en(key) ? "untranslated" : "translated";
  }

  private setKey(g: SourceGroup, key: string, s: KeyState) {
    g.apply(key, s.entry);
    if (s.record) this.records.set(id(g.name, key), s.record);
    else this.records.delete(id(g.name, key));
  }

  private isDirty(k: string): boolean {
    const [group, key] = splitId(k);
    const g = this.groups.find((x) => x.name === group);
    return g !== undefined && !sameKeyState(this.keyState(g, key), this.savedState(g, key));
  }

  private dirtyIds(): string[] {
    return [...this.touched].filter((k) => this.isDirty(k));
  }

  status(): DocStatus {
    return { dirtyCount: this.dirtyIds().length, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  draftInfo(): DraftInfo | null {
    const d = this.pendingDraft;
    if (!d) return null;
    return { count: d.edits.length, savedAt: d.savedAt, translators: [...new Set(d.edits.map((e) => e.record?.translator ?? "").filter(Boolean))] };
  }

  // ---- rows ----

  // Rows + summary of one group, validated as it is now.
  private buildGroup(gi: number): { info: GroupInfo; rows: Map<string, RowTuple>; loose: Issue[] } {
    const g = this.groups[gi]!;
    const report = g.report();
    const rows = new Map<string, RowTuple>();
    let dirtyCount = 0;
    for (const key of g.keys()) {
      const k = id(g.name, key);
      const dirty = this.touched.has(k) && this.isDirty(k);
      if (dirty) dirtyCount++;
      const state = this.keyState(g, key);
      const saved = g.saved(key);
      const meta = g.meta(key);
      rows.set(key, [
        gi,
        key,
        g.en(key),
        state.entry?.value ?? null,
        g.reference(key),
        report.byKey.get(key) ?? [],
        meta.legacyIds,
        meta.enLine,
        meta.line,
        (dirty ? ROW_DIRTY : 0) | (g.isKeep(state.entry) ? ROW_KEEP : 0),
        dirty ? (saved?.value ?? null) : null,
        this.statusOf(g, key, state),
        state.record,
      ]);
    }
    return {
      info: {
        source: g.source,
        name: g.name,
        itemType: g.itemType,
        canKeep: g.canKeep,
        enFile: g.enFile,
        file: g.targetFile,
        referenceFile: g.referenceFile,
        progress: report.progress,
        counts: report.counts,
        dirty: dirtyCount,
      },
      rows,
      loose: report.loose,
    };
  }

  // Everything the grid shows.
  rows(): RowsResponse {
    const info = this.folderInfo();
    const groups: GroupInfo[] = [];
    const rows: RowTuple[] = [];
    const issues: Issue[] = [];
    this.groups.forEach((_, gi) => {
      const b = this.buildGroup(gi);
      groups.push(b.info);
      rows.push(...b.rows.values());
      issues.push(...b.loose);
    });
    return { open: info, groups, rows, issues, status: this.status(), draft: this.draftInfo() };
  }

  private response(changes: { group: string; key: string }[]): MutationResponse {
    const built = new Map<number, ReturnType<Session["buildGroup"]>>();
    const changed: RowTuple[] = [];
    for (const c of changes) {
      const gi = this.groups.findIndex((g) => g.name === c.group);
      if (gi < 0) continue;
      if (!built.has(gi)) built.set(gi, this.buildGroup(gi));
      const row = built.get(gi)!.rows.get(c.key);
      if (row && !changed.includes(row)) changed.push(row);
    }
    const groups = this.groups.map((_, gi) => (built.get(gi) ?? this.buildGroup(gi)).info);
    return { changed, groups, status: this.status() };
  }

  // ---- edit ----

  // One undoable step: `next` gives the new state of each key from its current one.
  private async change(targets: { group: string; key: string }[], next: (cur: KeyState, g: SourceGroup, key: string) => KeyState) {
    const changes: Change[] = [];
    for (const { group, key } of targets) {
      const g = this.group(group);
      const before = this.keyState(g, key);
      const after = next(before, g, key);
      if (sameKeyState(before, after)) continue;
      this.setKey(g, key, after);
      changes.push({ group, key, before, after });
      this.touched.add(id(group, key));
    }
    if (changes.length) {
      this.undoStack.push(changes);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      await this.persistDraft();
    }
    return this.response(changes);
  }

  // A new record for `cur`, stamped with who / when; the merge base is the text before the first change.
  private stamped(g: SourceGroup, key: string, cur: KeyState, translator: string, patch: Partial<KeyRecord>): KeyRecord {
    return {
      status: this.statusOf(g, key, cur),
      note: cur.record?.note ?? "",
      translator,
      updatedAt: this.now().toISOString(),
      origin: cur.record?.origin ?? cur.entry?.value ?? "",
      ...patch,
    };
  }

  // A change that brings text + status + note back to the saved state restores the saved record
  // exactly, so the key is no longer dirty (instead of differing only by who / when).
  private settle(g: SourceGroup, key: string, entry: EntryState, next: KeyRecord): KeyState {
    const saved = this.savedState(g, key);
    if (sameState(entry, saved.entry) && next.status === this.statusOf(g, key, saved) && next.note === (saved.record?.note ?? "")) return saved;
    return { entry, record: next };
  }

  // Keys the English source has; keys only the translation has (resx extras) can be removed /
  // reverted, not given new text.
  private editable(g: SourceGroup, key: string): boolean {
    const inEn = g.en(key) !== null;
    if (!inEn && g.current(key) === null && g.saved(key) === null) {
      throw new AppError("not-editable", `${key} is not a key of ${g.name}.`, { group: g.name, key });
    }
    return inEn;
  }

  // null or "" removes the translation (the game shows English). Text is stored NFC. Editing
  // sets the status to translated (untranslated when removed).
  edit(group: string, key: string, value: string | null, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.folderInfo();
      const g = this.group(group);
      const inEn = this.editable(g, key);
      const text = value === null || value === "" ? null : value.normalize("NFC");
      if (text !== null && !inEn) throw new AppError("not-editable", `${key} is not in the English source.`, { group, key });
      if (text !== null) g.validateText(key, text);
      return this.change([{ group, key }], (cur) => {
        const entry = text === null ? null : g.entryFor(key, cur.entry, text);
        if (sameState(entry, cur.entry)) return cur;
        // Typed the saved text again = revert (status and note included).
        const saved = this.savedState(g, key);
        if (sameState(entry, saved.entry)) return saved;
        return this.settle(g, key, entry, this.stamped(g, key, cur, translator, { status: entry ? "translated" : "untranslated" }));
      });
    });
  }

  // keep = stay English on purpose (resx only).
  setKeep(group: string, key: string, keep: boolean, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.folderInfo();
      const g = this.group(group);
      if (!this.editable(g, key) || !g.canKeep) throw new AppError("not-editable", `${key} of ${group} cannot be marked "keep".`, { group, key });
      const en = g.en(key)!;
      return this.change([{ group, key }], (cur) => {
        const entry = g.keepEntry(key, cur.entry, keep);
        if (sameState(entry, cur.entry)) return cur;
        const status: Status = keep ? "translated" : entry && entry.value !== en ? "translated" : "untranslated";
        return this.settle(g, key, entry, this.stamped(g, key, cur, translator, { status }));
      });
    });
  }

  // Back to the files on disk (text and record).
  revert(group: string, key: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.folderInfo();
      const g = this.group(group);
      return this.change([{ group, key }], () => this.savedState(g, key));
    });
  }

  setStatus(keys: KeyRef[], status: Status, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.folderInfo();
      const targets = uniqueRefs(keys).filter(([group, key]) => {
        const g = this.groups.find((x) => x.name === group);
        return g !== undefined && (g.en(key) !== null || g.current(key) !== null);
      });
      return this.change(
        targets.map(([group, key]) => ({ group, key })),
        (cur, g, key) => {
          if (this.statusOf(g, key, cur) === status) return cur;
          return this.settle(g, key, cur.entry, this.stamped(g, key, cur, translator, { status }));
        },
      );
    });
  }

  setNote(group: string, key: string, note: string, translator: string): Promise<MutationResponse> {
    return this.exclusive(() => {
      this.folderInfo();
      const g = this.group(group);
      this.editable(g, key);
      const clean = note.replace(/[\t\r\n]+/g, " ").trim();
      return this.change([{ group, key }], (cur) => {
        if ((cur.record?.note ?? "") === clean) return cur;
        return this.settle(g, key, cur.entry, this.stamped(g, key, cur, translator, { note: clean }));
      });
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
    for (const c of ordered) {
      const g = this.groups.find((x) => x.name === c.group);
      if (!g) continue; // the group disappeared from disk
      this.setKey(g, c.key, c[side]);
      this.touched.add(id(c.group, c.key));
    }
    to.push(group);
    await this.persistDraft();
    return this.response(group);
  }

  // ---- TSV export / import ----

  exportTsv(target: string, keys: KeyRef[]): Promise<ExportResponse> {
    return this.exclusive(async () => {
      this.folderInfo();
      const rows = this.tsvRows(keys);
      const abs = this.storage.resolve(target);
      await writeText(this.storage, abs, serializeTranslationTsv(rows));
      return { path: abs, count: rows.length };
    });
  }

  // TSV rows (with BaseText) of the given keys, as they are now.
  private tsvRows(keys: KeyRef[]) {
    const rows = [];
    for (const [group, key] of uniqueRefs(keys)) {
      const g = this.groups.find((x) => x.name === group);
      if (!g) continue;
      const en = g.en(key);
      const cur = this.keyState(g, key);
      if (en === null && !cur.entry) continue;
      const value = cur.entry?.value ?? "";
      rows.push({
        group,
        key,
        english: en ?? "",
        value,
        status: this.statusOf(g, key, cur),
        translator: cur.record?.translator ?? "",
        updatedAt: cur.record?.updatedAt ?? "",
        base: cur.record?.origin ?? value,
        note: cur.record?.note ?? "",
      });
    }
    return rows;
  }

  // ---- translation packages (src/core/package.ts) ----

  // Identity of a group's English texts, to tell whether a package comes from the same MuMain version.
  private englishFingerprint(g: SourceGroup): string {
    return sha1(new TextEncoder().encode(JSON.stringify(g.keys().flatMap((k) => (g.en(k) === null ? [] : [[k, g.en(k)]]))))).slice(0, 16);
  }

  // Every key of the locale as a TSV, the translated files as saved, and the glossary (when given)
  // in one ZIP. Unsaved edits block it: the files inside and the TSV must say the same.
  exportPackage(target: string, opts: { glossary?: string | null; translator: string; tool: string }): Promise<ExportPackageResponse> {
    return this.exclusive(async () => {
      const info = this.folderInfo();
      const dirty = this.dirtyIds().length;
      if (dirty) throw new DirtyError(dirty);
      const st = this.storage;
      const keys: KeyRef[] = this.groups.flatMap((g) => g.keys().map((k): KeyRef => [g.name, k]));
      const rows = this.tsvRows(keys);
      const files: { path: string; bytes: Uint8Array }[] = [];
      for (const g of this.groups) {
        if (!g.targetFile) continue;
        const abs = st.join(info.folder.path, ...g.targetFile.split("/"));
        if (await st.exists(abs)) files.push({ path: g.targetFile, bytes: await st.read(abs) });
      }
      const glossary = opts.glossary ? serializeGlossary(parseGlossary(new TextDecoder().decode(await st.read(st.resolve(opts.glossary)))).entries) : null;
      const now = this.now();
      const translated = rows.filter((r) => r.value !== "" && r.english !== "").length;
      const bytes = buildPackage(
        {
          manifest: {
            locale: info.locale,
            createdAt: now.toISOString(),
            by: opts.translator,
            tool: opts.tool,
            rows: rows.length,
            translated,
            english: Object.fromEntries(this.groups.map((g) => [g.name, this.englishFingerprint(g)])),
          },
          translations: serializeTranslationTsv(rows),
          files,
          glossary,
        },
        now,
      );
      const abs = st.resolve(target);
      await st.writeAtomic(abs, bytes);
      return { path: abs, rows: rows.length, translated, files: files.length, glossary: glossary !== null };
    });
  }

  // The rows of an import file: a translation TSV / CSV, a Google Sheets tab (sheets.ts), a ZIP of
  // such tabs, or a translation package (whose locale must be the open one).
  private importParsed(bytes: Uint8Array, fileName: string): { parsed: TsvParseResult; pkg: ReadPackage | null } {
    const dec = new TextDecoder();
    if (!isZip(bytes)) return { parsed: this.withRealKeys(this.parseTab(fileName, dec.decode(bytes))), pkg: null };
    const entries = unzip(bytes);
    if (!entries.some((e) => e.name === "manifest.json" || e.name.endsWith("/manifest.json"))) {
      const tabs = entries.filter((e) => /\.(csv|tsv)$/i.test(e.name));
      if (!tabs.length) throw new AppError("package-invalid", "No manifest.json and no CSV / TSV files.", { detail: "no manifest.json" });
      const all: TsvParseResult = { rows: [], problems: [], columns: { base: true, status: true, translator: true, note: true } };
      for (const t of tabs) {
        const p = this.parseTab(t.name, dec.decode(t.bytes));
        all.rows.push(...p.rows);
        all.problems.push(...p.problems.map((x) => ({ ...x, detail: `${t.name.replace(/^.*\//, "")}: ${x.detail}` })));
        for (const k of Object.keys(all.columns) as (keyof TsvParseResult["columns"])[]) all.columns[k] &&= p.columns[k];
      }
      return { parsed: this.withRealKeys(all), pkg: null };
    }
    const pkg = readPackage(bytes);
    const { locale } = this.folderInfo();
    if (pkg.manifest.locale !== locale) {
      throw new AppError("package-locale", `The package holds ${pkg.manifest.locale} translations, ${locale} is open.`, { locale: pkg.manifest.locale, open: locale });
    }
    return { parsed: parseTranslationTsv(pkg.translations), pkg };
  }

  // A file with a Group column (or ItemType / ItemIndex), else a sheet tab named after its group.
  private parseTab(fileName: string, text: string): TsvParseResult {
    try {
      return parseTranslationTsv(text);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "tsv-header") throw e;
      const tab = sheetTab(fileName);
      const g = this.groups.find((x) => x.source === "resx" && x.name.toLowerCase() === tab.toLowerCase());
      if (!g) {
        const groups = this.groups.filter((x) => x.source === "resx").map((x) => x.name).join(", ");
        throw new AppError("sheet-tab", `"${tab}" (from ${fileName}) is not a group; the file name must end with the group name.`, { tab, groups });
      }
      return parseTranslationTsv(text, { defaultGroup: g.name });
    }
  }

  // Keys written as the C++ name ResxGen makes of them (as some sheets do) -> the resx key.
  private withRealKeys(parsed: TsvParseResult): TsvParseResult {
    const maps = new Map<string, Map<string, string>>();
    for (const row of parsed.rows) {
      const g = this.groups.find((x) => x.name === row.group);
      if (!g || g.source !== "resx" || g.en(row.key) !== null) continue;
      if (!maps.has(g.name)) maps.set(g.name, new Map(g.keys().filter((k) => g.en(k) !== null).map((k) => [toIdentifier(k), k])));
      const real = maps.get(g.name)!.get(row.key);
      if (real !== undefined) row.key = real;
    }
    return parsed;
  }

  // One CSV per Google Sheets tab, in one ZIP: a tab per string table (Key, English, <language>) and
  // one for all item names (ItemType, ItemIndex, English, <language>), with Status / Note / BaseText
  // at the end. Unsaved edits included, like a TSV export. BaseText is the text as exported (not the
  // merge base of a TSV): the sheet is a copy taken now, so importing a tab back into this copy
  // tells "changed in the sheet" (apply) from "changed here since" (conflict).
  exportSheets(target: string): Promise<ExportSheetsResponse> {
    return this.exclusive(async () => {
      const { locale } = this.folderInfo();
      const lang = languageName(locale);
      const tail = (g: SourceGroup, key: string): string[] => {
        const cur = this.keyState(g, key);
        const value = cur.entry?.value ?? "";
        return [value, this.statusOf(g, key, cur), cur.record?.note ?? "", value];
      };
      const entries: { name: string; bytes: Uint8Array }[] = [];
      const enc = new TextEncoder();
      let rows = 0;
      for (const g of this.groups.filter((x) => x.source === "resx")) {
        const lines = g.keys().filter((k) => g.en(k) !== null).map((k) => [k, g.en(k)!, ...tail(g, k)]);
        rows += lines.length;
        entries.push({ name: sheetFileName(locale, g.name), bytes: enc.encode(serializeCsv(["Key", "English", lang, ...SHEET_TAIL], lines)) });
      }
      const items = this.groups.filter((x) => x.source === "items");
      if (items.length) {
        const lines = items.flatMap((g) => g.keys().filter((k) => g.en(k) !== null).map((k) => [String(g.itemType), k, g.en(k)!, ...tail(g, k)]));
        rows += lines.length;
        entries.push({ name: sheetFileName(locale, ITEM_TAB), bytes: enc.encode(serializeCsv(["ItemType", "ItemIndex", "English", lang, ...SHEET_TAIL], lines)) });
      }
      const abs = this.storage.resolve(target);
      await this.storage.writeAtomic(abs, zip(entries, this.now()));
      return { path: abs, tabs: entries.length, rows };
    });
  }

  private packageInfo(pkg: ReadPackage): PackageInfo {
    const m = pkg.manifest;
    return {
      locale: m.locale,
      createdAt: m.createdAt ?? "",
      by: m.by ?? "",
      tool: m.tool ?? "",
      rows: m.rows ?? 0,
      translated: m.translated ?? 0,
      files: pkg.files.length,
      glossary: pkg.glossary !== null,
      englishChanged: this.groups.filter((g) => m.english[g.name] !== undefined && m.english[g.name] !== this.englishFingerprint(g)).map((g) => g.name),
    };
  }

  // Writes the glossary of a previewed package to .mumain-translator/glossary-<locale>.tsv and
  // returns that path (to be loaded as the glossary).
  importPackageGlossary(source: string, token: string): Promise<string> {
    return this.exclusive(async () => {
      const info = this.folderInfo();
      const st = this.storage;
      const abs = st.resolve(source);
      const bytes = await st.read(abs);
      if (sha1(bytes) !== token) throw new AppError("import-changed", "The file changed since the preview.", { file: st.basename(abs) });
      const { pkg } = this.importParsed(bytes, abs);
      if (!pkg?.glossary) throw new AppError("package-invalid", "The package has no glossary.", { detail: "no glossary.tsv" });
      const out = st.join(workDir(st, info.folder.path), `glossary-${info.locale}.tsv`);
      await writeText(st, out, pkg.glossary);
      return out;
    });
  }

  private analyze(parsed: TsvParseResult) {
    const analysis = analyzeImport(parsed.rows, (group, key) => {
      const g = this.groups.find((x) => x.name === group);
      const en = g ? g.en(key) : null;
      if (!g || en === null) return null;
      const cur = this.keyState(g, key);
      return { en, value: cur.entry?.value ?? null, status: this.statusOf(g, key, cur), check: g.check };
    });
    return { parsed, analysis };
  }

  previewImport(source: string): Promise<ImportPreview> {
    return this.exclusive(async () => {
      this.folderInfo();
      const abs = this.storage.resolve(source);
      const bytes = await this.storage.read(abs);
      const { parsed: rows, pkg } = this.importParsed(bytes, abs);
      const { parsed, analysis } = this.analyze(rows);
      return {
        path: abs,
        fileName: this.storage.basename(abs),
        token: sha1(bytes),
        items: analysis.items,
        counts: analysis.counts,
        problems: parsed.problems,
        hasBase: parsed.columns.base,
        ...(pkg ? { package: this.packageInfo(pkg) } : {}),
      };
    });
  }

  // Applies the chosen rows of a previewed file as ONE undoable step.
  applyImport(source: string, token: string, take: KeyRef[], translator: string): Promise<MutationResponse> {
    return this.exclusive(async () => {
      this.folderInfo();
      const abs = this.storage.resolve(source);
      const bytes = await this.storage.read(abs);
      if (sha1(bytes) !== token) throw new AppError("import-changed", "The file changed since the preview.", { file: this.storage.basename(abs) });
      const { parsed, analysis } = this.analyze(this.importParsed(bytes, abs).parsed);
      const rows = new Map(parsed.rows.map((r) => [id(r.group, r.key), r]));
      const items = new Map(analysis.items.map((it) => [id(it.group, it.key), it]));
      const wanted = uniqueRefs(take).filter(([group, key]) => {
        const it = items.get(id(group, key));
        if (it === undefined || it.kind === "invalid") return false;
        // A text the file cannot hold is never taken (the preview marks it invalid already).
        try {
          if (it.kind !== "status") this.group(group).validateText(key, it.theirs);
          return true;
        } catch {
          return false;
        }
      });
      return this.change(
        wanted.map(([group, key]) => ({ group, key })),
        (cur, g, key) => {
          const it = items.get(id(g.name, key))!;
          const row = rows.get(id(g.name, key))!;
          const entry = it.kind === "status" ? cur.entry : g.entryFor(key, cur.entry, it.theirs);
          return {
            entry,
            record: {
              status: it.theirsStatus ?? (it.kind === "status" ? this.statusOf(g, key, cur) : "translated"),
              note: row.note ? row.note : (cur.record?.note ?? ""),
              translator: row.translator || translator,
              updatedAt: row.updatedAt || this.now().toISOString(),
              origin: cur.record?.origin ?? cur.entry?.value ?? "",
            },
          };
        },
      );
    });
  }

  // ---- draft ----

  // Applies the draft as one (undoable) step; edits of groups / keys that no longer exist, or texts
  // the file cannot hold, are skipped.
  restoreDraft(): Promise<MutationResponse & { skipped: number }> {
    return this.exclusive(async () => {
      this.folderInfo();
      const draft = this.pendingDraft;
      if (!draft) return { ...this.response([]), skipped: 0 };
      this.pendingDraft = null;
      const states = new Map<string, KeyState>();
      let skipped = 0;
      for (const e of draft.edits) {
        const g = this.groups.find((x) => x.name === e.group);
        const known = g && (g.en(e.key) !== null || g.current(e.key) !== null);
        let ok = !!known;
        if (ok && e.state !== null) {
          try {
            if (g!.en(e.key) === null) throw new Error("extra");
            g!.validateText(e.key, e.state.value);
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          skipped++;
          continue;
        }
        states.set(id(e.group, e.key), { entry: e.state, record: e.record });
      }
      const res = await this.change(
        [...states.keys()].map((k) => {
          const [group, key] = splitId(k);
          return { group, key };
        }),
        (_cur, g, key) => states.get(id(g.name, key))!,
      );
      await this.persistDraft();
      return { ...res, skipped };
    });
  }

  discardDraft(): Promise<void> {
    return this.exclusive(async () => {
      const info = this.info;
      if (!info) return;
      this.pendingDraft = null;
      if (this.dirtyIds().length === 0) await deleteDraft(this.storage, info.folder.path, info.locale);
    });
  }

  // Called inside `exclusive`. A failed draft write never fails the edit itself.
  private async persistDraft() {
    const info = this.info;
    const st = this.storage;
    if (!info) return;
    const folder = info.folder.path;
    try {
      // An unanswered old draft plus a new edit: archive the old draft under another name instead of overwriting it.
      if (this.pendingDraft) {
        const old = draftPath(st, folder, info.locale);
        if (await st.exists(old)) await st.rename(old, st.join(workDir(st, folder), `draft-${info.locale}-${stamp(this.now())}.json`));
        this.pendingDraft = null;
      }
      const dirty = this.dirtyIds();
      if (!dirty.length) {
        await deleteDraft(st, folder, info.locale);
        return;
      }
      await writeDraft(st, folder, {
        version: 1,
        locale: info.locale,
        savedAt: this.now().toISOString(),
        edits: dirty.map((k) => {
          const [group, key] = splitId(k);
          const s = this.keyState(this.group(group), key);
          return { group, key, state: s.entry, record: s.record };
        }),
      });
    } catch (e) {
      console.warn(`Could not write draft: ${(e as Error).message}`);
    }
  }

  // ---- proposals ----

  // The newest undecided proposal of each key, checked against the rows as they are now (unsaved
  // edits included).
  proposals(): Promise<ProposalsResponse> {
    return this.exclusive(async () => this.proposalList(await this.scanProposals()));
  }

  private scanProposals(): Promise<ProposalScan> {
    const { folder, locale } = this.folderInfo();
    return loadProposals(this.storage, folder.path, locale);
  }

  private pendingProposals(scan: ProposalScan): Map<string, PendingProposal> {
    const out = new Map<string, PendingProposal>();
    for (const p of scan.files) {
      p.file.items.forEach((it, index) => {
        if (p.decided.has(index)) return;
        const k = id(it.group, it.key);
        const prev = out.get(k); // files are oldest first: a later one is newer
        out.set(k, { p, index, older: prev ? [...prev.older, { p: prev.p, index: prev.index }] : [] });
      });
    }
    return out;
  }

  private proposalState(it: ProposalItem): { state: ProposalState; issues: RowIssue[] } {
    const { locale } = this.folderInfo();
    const g = this.groups.find((x) => x.name === it.group);
    const en = g ? g.en(it.key) : null;
    if (!g || en === null) return { state: "unknown", issues: [] };
    const text = it.value.normalize("NFC");
    const issues = g.check(en, text).map((i): RowIssue => (Object.keys(i.params).length ? [i.code, locale, i.params] : [i.code, locale]));
    try {
      if (text === "") throw new Error("empty");
      g.validateText(it.key, text);
    } catch {
      return { state: "invalid", issues };
    }
    const cur = this.keyState(g, it.key);
    const now = cur.entry?.value ?? "";
    if (cur.entry && now === text) return { state: "same", issues };
    if (this.statusOf(g, it.key, cur) === "reviewed") return { state: "reviewed", issues };
    // A proposal without the English text it was made from is only checked against the translation.
    if ((it.english && it.english !== en) || it.base.normalize("NFC") !== now) return { state: "stale", issues };
    return { state: "ok", issues };
  }

  proposalInfo(items: { group: string; key: string; value: string }[]): Promise<ProposalInfo[]> {
    return this.exclusive(() => {
      this.folderInfo();
      return items.map((it) => {
        const g = this.groups.find((x) => x.name === it.group);
        const english = g ? g.en(it.key) : null;
        const cur = g && english !== null ? this.keyState(g, it.key) : null;
        const base = cur?.entry?.value ?? "";
        const r = this.proposalState({ group: it.group, key: it.key, english: english ?? "", base, value: it.value, note: "" });
        return { ...r, english, base, status: g && cur ? this.statusOf(g, it.key, cur) : null };
      });
    });
  }

  private proposalList(scan: ProposalScan): ProposalsResponse {
    const items: ProposalRow[] = [];
    for (const { p, index, older } of this.pendingProposals(scan).values()) {
      const it = p.file.items[index]!;
      items.push({
        file: p.name,
        index,
        group: it.group,
        key: it.key,
        english: it.english,
        base: it.base,
        value: it.value,
        note: it.note,
        by: p.file.by,
        createdAt: p.file.createdAt,
        batchNote: p.file.note,
        ...this.proposalState(it),
        older: older.length,
      });
    }
    return { dir: `${SIDECAR_DIR}/proposals`, items, broken: scan.broken };
  }

  // Accepting is one undoable edit (status translated; the proposal's note becomes the row's note
  // when it has none, marked "AI"); every decision is written to the decision files right away, and
  // older undecided proposals of the same keys are marked superseded. Only the newest undecided
  // proposal of a key can be decided; anything else (gone from disk, decided meanwhile, a text the
  // file cannot hold) is skipped.
  decideProposals(decisions: ProposalDecision[], translator: string): Promise<DecideResponse> {
    return this.exclusive(async () => {
      const { folder } = this.folderInfo();
      const scan = await this.scanProposals();
      const pending = this.pendingProposals(scan);
      const byName = new Map(scan.files.map((p) => [p.name, p]));
      const at = this.now().toISOString();
      const written = new Map<LoadedProposal, Decision[]>();
      const record = (p: LoadedProposal, index: number, d: Pick<Decision, "action" | "value" | "reason">) => {
        const it = p.file.items[index]!;
        const list = written.get(p) ?? [];
        list.push({ index, group: it.group, key: it.key, english: it.english, proposed: it.value, by: translator, at, ...d });
        written.set(p, list);
      };
      const takes = new Map<string, { it: ProposalItem; text: string }>();
      let decided = 0;
      let skipped = 0;
      for (const d of Array.isArray(decisions) ? decisions : []) {
        const p = byName.get(d?.file);
        const it = p?.file.items[d?.index];
        const k = it ? id(it.group, it.key) : "";
        const cur = pending.get(k);
        if (!p || !it || !cur || cur.p !== p || cur.index !== d.index) {
          skipped++;
          continue;
        }
        if (d.action === "accept") {
          const text = (typeof d.value === "string" ? d.value : it.value).normalize("NFC");
          const { state } = this.proposalState({ ...it, value: text });
          if (state === "unknown" || state === "invalid") {
            skipped++;
            continue;
          }
          takes.set(k, { it, text });
          record(p, d.index, { action: text === it.value.normalize("NFC") ? "accepted" : "edited", value: text, reason: "" });
        } else if (d.action === "reject") {
          record(p, d.index, { action: "rejected", value: null, reason: oneLine(d.reason) });
        } else {
          skipped++;
          continue;
        }
        decided++;
        pending.delete(k); // decided once
        for (const o of cur.older) record(o.p, o.index, { action: "superseded", value: null, reason: "" });
      }

      const res = await this.change(
        [...takes.keys()].map((k) => {
          const [group, key] = splitId(k);
          return { group, key };
        }),
        (cur, g, key) => {
          const { it, text } = takes.get(id(g.name, key))!;
          const entry = g.entryFor(key, cur.entry, text);
          if (sameState(entry, cur.entry)) return cur;
          const note = cur.record?.note || oneLine(it.note ? `AI: ${it.note}` : "AI");
          return this.settle(g, key, entry, this.stamped(g, key, cur, translator, { status: "translated", note }));
        },
      );
      for (const [p, list] of written) await recordDecisions(this.storage, folder.path, p, list);
      return { ...res, decided, skipped, proposals: this.proposalList(await this.scanProposals()) };
    });
  }

  // ---- save ----

  save(opts: { force?: boolean } = {}): Promise<SaveResult> {
    return this.exclusive(() => this.saveNow(opts));
  }

  private async saveNow(opts: { force?: boolean }): Promise<SaveResult> {
    const info = this.folderInfo();
    const st = this.storage;
    const folder = info.folder.path;
    const logPath = changeLogPath(st, folder);
    const dirty = this.dirtyIds();
    if (!dirty.length) return { files: [], created: [], savedCount: 0, backups: [], logPath };

    // Groups with a changed text; the project file is written on every save with changes.
    const byGroup = new Map<string, string[]>();
    for (const k of dirty) {
      const [group, key] = splitId(k);
      const g = this.group(group);
      if (!sameState(g.current(key), g.saved(key))) byGroup.set(group, [...(byGroup.get(group) ?? []), key]);
    }

    // Someone / something else wrote a file since we read it (git pull, Drive sync, another editor).
    const planned: { g: SourceGroup; plan: WritePlan; keys: string[] }[] = [];
    const conflicts: string[] = [];
    for (const g of this.groups) {
      const keys = byGroup.get(g.name);
      if (!keys) continue;
      const plan = g.planWrite(keys); // verified: reads back as intended
      if (!opts.force && (await g.diskChanged())) conflicts.push(plan.file);
      planned.push({ g, plan, keys });
    }
    const projectFile = projectPath(st, folder, info.locale);
    if ((await readProjectText(st, folder, info.locale)) !== this.projectText && !opts.force) {
      conflicts.push(`${st.basename(workDir(st, folder))}/${st.basename(projectFile)}`);
    }
    if (conflicts.length) throw new ConflictError(conflicts);

    const now = this.now();
    const backups: string[] = [];
    const created: string[] = [];
    const log = [];
    for (const { g, plan, keys } of planned) {
      const b = await backup(st, folder, plan.path, now);
      if (b) backups.push(b);
      else created.push(plan.file);
      await st.writeAtomic(plan.path, new TextEncoder().encode(plan.text));
      for (const key of keys) {
        const r = this.records.get(id(g.name, key));
        log.push({
          at: r?.updatedAt || now.toISOString(),
          translator: r?.translator ?? "",
          file: plan.file,
          key,
          oldValue: g.saved(key)?.value ?? null,
          newValue: g.current(key)?.value ?? null,
        });
      }
      g.committed(plan); // the written file becomes the new saved state
    }
    if (log.length) await appendChangeLog(st, folder, log);

    this.savedRecords = new Map(this.records);
    await backup(st, folder, projectFile, now);
    this.projectText = await writeProject(st, folder, this.projectData());
    for (const k of dirty) this.touched.delete(k);
    await deleteDraft(st, folder, info.locale);
    this.pendingDraft = null;
    if (created.length) this.info = { ...info, folder: (await this.readListing(folder)).listing };
    // Undo history is kept (undo after save = a new edit).
    return { files: planned.map((p) => p.plan.file), created, savedCount: dirty.length, backups, logPath };
  }

  // ---- reload ----

  // Reads every file again (en, target, reference, project) and puts the unsaved edits back on
  // top. A key whose text also changed on disk keeps our version and is reported as a conflict.
  rebase(): Promise<RebaseResponse> {
    return this.exclusive(async () => {
      const info = this.folderInfo();
      const { ws, listing } = await this.readListing(info.folder.path);
      const fresh = await this.loadGroups(ws, info.locale, info.reference);
      const changedFiles: string[] = [];
      const conflicts: { group: string; key: string }[] = [];

      // What we have that is not saved, before replacing the files.
      const ours = new Map<string, { base: EntryState; mine: KeyState }>();
      for (const k of this.dirtyIds()) {
        const [group, key] = splitId(k);
        const g = this.group(group);
        ours.set(k, { base: g.saved(key), mine: this.keyState(g, key) });
      }
      for (const g of fresh) {
        const old = this.groups.find((x) => x.name === g.name);
        if (old && g.baseHash() !== old.baseHash()) changedFiles.push(g.targetFile ?? g.name);
      }

      this.workspace = ws;
      this.groups = fresh;
      this.info = { ...info, folder: listing, loadedAt: this.now().toISOString() };
      await this.loadProject();
      this.records = new Map(this.savedRecords);
      this.touched = new Set();
      for (const [k, { base, mine }] of ours) {
        const [group, key] = splitId(k);
        const g = fresh.find((x) => x.name === group);
        if (!g) continue; // the group disappeared from disk: its edits are dropped
        if (g.en(key) === null && g.saved(key) === null && mine.entry !== null) continue; // the item / key is gone
        const theirs = g.saved(key);
        if (!sameState(theirs, base) && !sameState(theirs, mine.entry)) conflicts.push({ group, key });
        this.setKey(g, key, mine);
        this.touched.add(k);
      }
      await this.persistDraft();
      return { changedFiles, conflicts };
    });
  }
}

function uniqueRefs(keys: KeyRef[]): KeyRef[] {
  const seen = new Set<string>();
  const out: KeyRef[] = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!Array.isArray(k) || typeof k[0] !== "string" || typeof k[1] !== "string") continue;
    const i = id(k[0], k[1]);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push([k[0], k[1]]);
  }
  return out;
}
