// glossaryFiles.ts - Load / save the team glossary through a Storage. The glossary is a standalone
// file shared by the team, not tied to the open game folder.

import { type GlossaryEntry, parseGlossary, serializeGlossary } from "../core";
import type { GlossaryInfo } from "../shared/api";
import { type Storage, readText, writeText } from "./storage";

export async function loadGlossaryFile(st: Storage, file: string): Promise<GlossaryInfo> {
  const p = st.resolve(file);
  const g = parseGlossary(await readText(st, p));
  return { path: p, fileName: st.basename(p), format: g.format, entries: g.entries };
}

// Always written in our TSV format; blank terms are dropped.
export async function saveGlossaryFile(st: Storage, file: string, raw: unknown[]): Promise<GlossaryInfo> {
  const p = st.resolve(file);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const entries: GlossaryEntry[] = raw
    .filter((e): e is GlossaryEntry => typeof (e as GlossaryEntry)?.term === "string" && (e as GlossaryEntry).term.trim() !== "")
    .map((e) => ({ term: e.term.trim(), translation: str(e.translation).trim() || null, note: str(e.note), category: str(e.category) }));
  await writeText(st, p, serializeGlossary(entries));
  return { path: p, fileName: st.basename(p), format: "tsv", entries };
}
