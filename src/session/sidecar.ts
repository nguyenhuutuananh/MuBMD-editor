// sidecar.ts - Side data kept in a "Items.mubmd/" folder next to the item data folder (Data/Items.mubmd;
// outside Data/Items, so the game never reads it):
//   backups/Group00_Sword-20260928-111300.json   an item file before each save that rewrote it (newest MAX_BACKUPS kept per file)
//   backups/project-….json             the previous project.json before each save
//   changes.tsv                        log: who renamed which slot, from what to what
//   project.json                       per-slot status / note / translator / merge base (see Project)
//   draft.json                         unsaved edits (written after every edit)
// Everything goes through a Storage, so it works on disk and in the browser alike.

import type { SlotRecord } from "../shared/api";
import { type Storage, copyFile, splitName, tryReadText, writeText } from "./storage";

export const MAX_BACKUPS = 20;

export const workDir = (itemsDir: string) => `${itemsDir}.mubmd`;

// 2026-09-28 11:13:00 -> "20260928-111300" (local time)
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- backups ----

async function pruneBackups(st: Storage, dir: string, prefix: string, ext: string) {
  const all = (await st.list(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort(); // names contain the time
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) await st.remove(st.join(dir, old));
}

// Copy `source` (default: the file itself) into <target>.mubmd/backups/ as <name>-<stamp><ext> and
// prune old copies. Returns the backup path, or null if the source does not exist.
export async function backup(st: Storage, target: string, now: Date, source = target): Promise<string | null> {
  if (!(await st.exists(source))) return null;
  const dir = st.join(workDir(target), "backups");
  const { name, ext } = splitName(st.basename(source));
  let dest = st.join(dir, `${name}-${stamp(now)}${ext}`);
  for (let i = 2; await st.exists(dest); i++) dest = st.join(dir, `${name}-${stamp(now)}-${i}${ext}`);
  await copyFile(st, source, dest);
  await pruneBackups(st, dir, `${name}-`, ext);
  return dest;
}

// ---- change log ----

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

export const changeLogPath = (st: Storage, target: string) => st.join(workDir(target), "changes.tsv");

export async function appendChangeLog(st: Storage, target: string, rows: ChangeLogRow[]): Promise<string> {
  const logPath = changeLogPath(st, target);
  const lines = rows.map((r) => [r.at, cleanCell(r.translator), r.itemType, r.itemIndex, cleanCell(r.oldName), cleanCell(r.newName)].join("\t"));
  const existing = (await tryReadText(st, logPath)) ?? LOG_HEADER;
  await writeText(st, logPath, existing + lines.map((l) => `${l}\n`).join(""));
  return logPath;
}

// ---- project.json ----

export interface Project {
  version: 2;
  // SHA-1 of the translated names as last written by this tool. If the names on disk differ when
  // opened, they were changed from outside (e.g. a new master copy arrived), so merge bases are reset.
  namesSha1: string;
  records: Record<string, SlotRecord>;
}

export const projectPath = (st: Storage, target: string) => st.join(workDir(target), "project.json");

export const readProjectText = (st: Storage, target: string) => tryReadText(st, projectPath(st, target));

// A corrupt project.json is treated as absent rather than blocking the file; it is backed up on the next save.
export function parseProject(text: string | null): Project | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Project;
    if (p?.version !== 2 || typeof p.records !== "object" || p.records === null) return null;
    return p;
  } catch {
    return null;
  }
}

export async function writeProject(st: Storage, target: string, project: Project): Promise<string> {
  const text = `${JSON.stringify(project, null, 1)}\n`;
  await writeText(st, projectPath(st, target), text);
  return text;
}

// ---- draft.json ----

export interface DraftSlot {
  slot: number;
  name?: string; // present when the name differs from the files
  record?: SlotRecord | null; // present when the record differs from project.json (null = remove)
}

export interface Draft {
  version: 2;
  baseSha1: string;
  savedAt: string;
  slots: DraftSlot[];
}

export const draftPath = (st: Storage, target: string) => st.join(workDir(target), "draft.json");

export function writeDraft(st: Storage, target: string, draft: Draft): Promise<void> {
  return writeText(st, draftPath(st, target), JSON.stringify(draft, null, 1));
}

// A corrupt / malformed draft is treated as absent (never blocks opening the folder).
export async function readDraft(st: Storage, target: string): Promise<Draft | null> {
  const text = await tryReadText(st, draftPath(st, target));
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Draft;
    if (d?.version === 2 && Array.isArray(d.slots)) return d;
    return null;
  } catch {
    return null;
  }
}

export const deleteDraft = (st: Storage, target: string) => st.remove(draftPath(st, target));
