// storage.ts - All disk writes: safe file writes, backups, change log, draft.
//
// Side data lives in a "<Item.bmd>.mubmd/" folder next to the file:
//   backups/Item-20260928-111300.bmd   the previous version before each save (newest MAX_BACKUPS kept)
//   changes.tsv                        log: who renamed which slot, from what to what
//   project.json                       per-slot status / note / translator / merge base (see Project)
//   draft.json                         unsaved edits (written after every edit)

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../core";
import type { SlotRecord } from "../shared/api";

export const MAX_BACKUPS = 20;

export function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export function workDir(bmdPath: string): string {
  return `${bmdPath}.mubmd`;
}

// 2026-09-28 11:13:00 -> "20260928-111300" (local time)
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

// Write to a temp file in the same folder, then rename over the target: a power loss / crash
// mid-write never leaves a half-written Item.bmd.
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

function pruneBackups(dir: string, prefix: string, ext: string) {
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort(); // names contain the timestamp, so sorting by name = by time
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
}

// Copy `source` (default: the file itself) into <target>.mubmd/backups/ as <name>-<stamp><ext> and
// prune old copies. Returns the backup path, or null if the source does not exist.
export function backup(target: string, now: Date, source = target): string | null {
  if (!fs.existsSync(source)) return null;
  const dir = path.join(workDir(target), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const { name, ext } = path.parse(source);
  let dest = path.join(dir, `${name}-${stamp(now)}${ext}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${name}-${stamp(now)}-${i}${ext}`);
  fs.copyFileSync(source, dest);
  pruneBackups(dir, `${name}-`, ext);
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

// ---- project.json ----

export interface Project {
  version: 1;
  // SHA-1 of Item.bmd as last written by this tool. If the file on disk differs when opened, it was
  // replaced from outside (e.g. a new master copy arrived), so merge bases are reset to its names.
  bmdSha1: string;
  records: Record<string, SlotRecord>;
}

export const projectPath = (target: string) => path.join(workDir(target), "project.json");

export function readProjectText(target: string): string | null {
  try {
    return fs.readFileSync(projectPath(target), "utf-8");
  } catch {
    return null;
  }
}

// A corrupt project.json is treated as absent rather than blocking the file; it is backed up on the next save.
export function parseProject(text: string | null): Project | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Project;
    if (p?.version !== 1 || typeof p.records !== "object" || p.records === null) return null;
    return p;
  } catch {
    return null;
  }
}

export function writeProject(target: string, project: Project): string {
  fs.mkdirSync(workDir(target), { recursive: true });
  const text = `${JSON.stringify(project, null, 1)}\n`;
  atomicWrite(projectPath(target), new TextEncoder().encode(text));
  return text;
}

// ---- draft.json ----

export interface DraftSlot {
  slot: number;
  name?: string; // present when the name differs from the file
  record?: SlotRecord | null; // present when the record differs from project.json (null = remove)
}

export interface Draft {
  version: 2;
  baseSha1: string;
  savedAt: string;
  slots: DraftSlot[];
}

interface DraftV1 {
  version: 1;
  baseSha1: string;
  savedAt: string;
  edits: { slot: number; name: string; translator: string; at: string }[];
}

const draftPath = (target: string) => path.join(workDir(target), "draft.json");

export function writeDraft(target: string, draft: Draft): void {
  fs.mkdirSync(workDir(target), { recursive: true });
  atomicWrite(draftPath(target), new TextEncoder().encode(JSON.stringify(draft, null, 1)));
}

// A corrupt / malformed draft is treated as absent (never blocks opening the file).
// Version 1 drafts (names only) are upgraded on read.
export function readDraft(target: string): Draft | null {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(target), "utf-8")) as Draft | DraftV1;
    if (d?.version === 2 && Array.isArray(d.slots)) return d;
    if (d?.version === 1 && Array.isArray(d.edits)) {
      return {
        version: 2,
        baseSha1: d.baseSha1,
        savedAt: d.savedAt,
        slots: d.edits.map((e) => ({
          slot: e.slot,
          name: e.name,
          record: { status: "translated", note: "", translator: e.translator ?? "", updatedAt: e.at ?? "" },
        })),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteDraft(target: string): void {
  fs.rmSync(draftPath(target), { force: true });
}

// ---- export ----

export function writeText(target: string, text: string): void {
  atomicWrite(target, new TextEncoder().encode(text));
}
