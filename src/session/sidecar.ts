// sidecar.ts - Side data kept in a hidden ".mumain-translator/" folder at the workspace root (the
// MuMain checkout, or the picked game / Localization folder):
//   backups/Game.vi-20260929-111300.resx   a file before each save that rewrote it (newest MAX_BACKUPS kept per file)
//   backups/Group00_Sword-20260929-111300.json
//   changes.tsv                           log: who changed which key of which file, from what to what
//   project-vi.json                       per-key status / note / translator / merge base of one locale
//   draft-vi.json                         unsaved edits of one locale (written after every edit)
// Neither MuMain's build (ResxGen reads the top-level *.resx of Localization) nor the game (it reads
// the top-level *.json of Data/Items) looks into it; in a checkout add ".mumain-translator/" to
// .gitignore (or .git/info/exclude).
// Everything goes through a Storage, so it works on disk and in the browser alike.

import { isStatus } from "../core";
import type { KeyRecord } from "../shared/api";
import type { EntryState } from "./sources/types";

export type { EntryState };
import { type Storage, copyFile, splitName, tryReadText, writeText } from "./storage";

export const MAX_BACKUPS = 20;
export const SIDECAR_DIR = ".mumain-translator";

export const workDir = (st: Storage, folder: string) => st.join(folder, SIDECAR_DIR);

// 2026-09-29 11:13:00 -> "20260929-111300" (local time)
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- backups ----

async function pruneBackups(st: Storage, dir: string, prefix: string, ext: string) {
  const all = (await st.list(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort(); // names contain the time
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) await st.remove(st.join(dir, old));
}

// Copies `file` into .mumain-translator/backups/ as <name>-<stamp><ext> and prunes old copies.
// (project-vi.json is backed up the same way.)
// Returns the backup path, or null if the file does not exist (a file created by this save).
export async function backup(st: Storage, folder: string, file: string, now: Date): Promise<string | null> {
  if (!(await st.exists(file))) return null;
  const dir = st.join(workDir(st, folder), "backups");
  const { name, ext } = splitName(st.basename(file));
  let dest = st.join(dir, `${name}-${stamp(now)}${ext}`);
  for (let i = 2; await st.exists(dest); i++) dest = st.join(dir, `${name}-${stamp(now)}-${i}${ext}`);
  await copyFile(st, file, dest);
  await pruneBackups(st, dir, `${name}-`, ext);
  return dest;
}

// ---- change log ----

export interface ChangeLogRow {
  at: string;
  translator: string;
  file: string;
  key: string;
  oldValue: string | null; // null: the key was not in the file
  newValue: string | null; // null: removed (the game shows English again)
}

const LOG_HEADER = "Time\tTranslator\tFile\tKey\tOldValue\tNewValue\n";
// Tabs / line breaks inside a cell would break the TSV; "-" marks "absent".
const cell = (s: string | null) => (s === null ? "-" : s.replace(/\t/g, " ").replace(/\r?\n/g, "⏎"));

export const changeLogPath = (st: Storage, folder: string) => st.join(workDir(st, folder), "changes.tsv");

export async function appendChangeLog(st: Storage, folder: string, rows: ChangeLogRow[]): Promise<string> {
  const logPath = changeLogPath(st, folder);
  const lines = rows.map((r) => [r.at, cell(r.translator), r.file, cell(r.key), cell(r.oldValue), cell(r.newValue)].join("\t"));
  const existing = (await tryReadText(st, logPath)) ?? LOG_HEADER;
  await writeText(st, logPath, existing + lines.map((l) => `${l}\n`).join(""));
  return logPath;
}

// ---- project-<locale>.json ----

export interface Project {
  version: 1;
  locale: string;
  // Per group, the identity of its saved translations as last read / written by this tool (see
  // SourceGroup.baseHash). A group that differs when opened was changed from outside (git pull, a
  // new master copy): its merge bases are reset.
  bases: Record<string, string>;
  records: Record<string, Record<string, KeyRecord>>; // group -> key -> record
}

export const projectPath = (st: Storage, folder: string, locale: string) => st.join(workDir(st, folder), `project-${locale}.json`);

export const readProjectText = (st: Storage, folder: string, locale: string) => tryReadText(st, projectPath(st, folder, locale));

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseRecord(r: unknown): KeyRecord | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (!isStatus(o.status)) return null;
  const rec: KeyRecord = { status: o.status, note: str(o.note), translator: str(o.translator), updatedAt: str(o.updatedAt) };
  if (typeof o.origin === "string") rec.origin = o.origin;
  return rec;
}

// A corrupt project file is treated as absent rather than blocking the folder; it is backed up on the next save.
export function parseProject(text: string | null, locale: string): Project | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Project;
    if (p?.version !== 1 || p.locale !== locale || typeof p.records !== "object" || p.records === null) return null;
    const records: Project["records"] = {};
    for (const [group, keys] of Object.entries(p.records)) {
      if (!keys || typeof keys !== "object") continue;
      for (const [key, r] of Object.entries(keys)) {
        const rec = parseRecord(r);
        if (rec) (records[group] ??= {})[key] = rec;
      }
    }
    return { version: 1, locale, bases: typeof p.bases === "object" && p.bases ? p.bases : {}, records };
  } catch {
    return null;
  }
}

export async function writeProject(st: Storage, folder: string, project: Project): Promise<string> {
  const text = `${JSON.stringify(project, null, 1)}\n`;
  await writeText(st, projectPath(st, folder, project.locale), text);
  return text;
}

// ---- draft-<locale>.json ----

export interface DraftEdit {
  group: string;
  key: string;
  state: EntryState;
  record: KeyRecord | null; // the record at the time (null = none)
}

export interface Draft {
  version: 1;
  locale: string;
  savedAt: string;
  edits: DraftEdit[];
}

export const draftPath = (st: Storage, folder: string, locale: string) => st.join(workDir(st, folder), `draft-${locale}.json`);

export function writeDraft(st: Storage, folder: string, draft: Draft): Promise<void> {
  return writeText(st, draftPath(st, folder, draft.locale), JSON.stringify(draft, null, 1));
}

const isState = (s: unknown): s is EntryState =>
  s === null ||
  (typeof s === "object" &&
    typeof (s as { value?: unknown }).value === "string" &&
    ((s as { comment?: unknown }).comment === null || typeof (s as { comment?: unknown }).comment === "string"));

// A corrupt / malformed draft is treated as absent (never blocks opening the folder).
export async function readDraft(st: Storage, folder: string, locale: string): Promise<Draft | null> {
  const text = await tryReadText(st, draftPath(st, folder, locale));
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Draft;
    if (d?.version !== 1 || d.locale !== locale || !Array.isArray(d.edits)) return null;
    const edits = d.edits
      .filter((e) => typeof e?.group === "string" && typeof e.key === "string" && isState(e.state))
      .map((e) => ({ group: e.group, key: e.key, state: e.state, record: parseRecord(e.record) }));
    return edits.length ? { ...d, edits } : null;
  } catch {
    return null;
  }
}

export const deleteDraft = (st: Storage, folder: string, locale: string) => st.remove(draftPath(st, folder, locale));
