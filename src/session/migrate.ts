// migrate.ts - Carries over the side data of the two tools this one replaces, the first time a
// workspace is opened for a locale (no .mumain-translator/project-<locale>.json yet):
//   MuResx-editor  <Localization>/.muresx/project-<locale>.json, draft-<locale>.json
//                  (same records / draft per group + key; merge bases per file)
//   MuBMD-editor   <Data/Items>.mubmd/project.json, draft.json (2.x: Vietnamese item names only;
//                  records per slot = group * 512 + number)
// The old folders are only read (never changed or deleted); their change logs and backups stay there.
// What is found is written as this tool's project / draft files, which the Session then reads as
// usual, so merge bases of groups changed since are reset the normal way.

import { MAX_ITEM_INDEX, sha1 } from "../core";
import type { KeyRecord, MigrationInfo } from "../shared/api";
import { type DraftEdit, type EntryState, type Project, draftPath, parseRecord, projectPath, writeDraft, writeProject } from "./sidecar";
import type { SourceGroup } from "./sources/types";
import { type Storage, tryReadText } from "./storage";
import type { Workspace } from "./workspace";


// A value no group hash can have: the group's merge bases are reset when the project is read.
const CHANGED = "changed-since-the-old-tool";

const json = (text: string | null): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const isState = (s: unknown): s is EntryState =>
  s === null ||
  (typeof s === "object" &&
    typeof (s as { value?: unknown }).value === "string" &&
    ((s as { comment?: unknown }).comment === null || typeof (s as { comment?: unknown }).comment === "string"));

export async function migrateLegacy(
  st: Storage,
  ws: Workspace,
  root: string,
  locale: string,
  groups: SourceGroup[],
  now: Date,
): Promise<MigrationInfo | null> {
  if (await st.exists(projectPath(st, root, locale))) return null;
  const rel = (p: string) => (p.startsWith(`${root}/`) || p.startsWith(`${root}\\`) ? p.slice(root.length + 1).replace(/\\/g, "/") : p);

  const records: Project["records"] = {};
  const bases: Record<string, string> = {};
  const edits: DraftEdit[] = [];
  const from: string[] = [];
  let count = 0;
  const put = (group: string, key: string, r: KeyRecord) => {
    (records[group] ??= {})[key] = r;
    count++;
  };

  // ---- MuResx-editor ----
  if (ws.resx) {
    const dir = st.join(ws.resx.dir, ".muresx");
    const project = json(await tryReadText(st, st.join(dir, `project-${locale}.json`)));
    const draft = json(await tryReadText(st, st.join(dir, `draft-${locale}.json`)));
    const resx = groups.filter((g) => g.source === "resx");
    if (project?.locale === locale || draft?.locale === locale) from.push(rel(dir));
    if (project?.locale === locale) {
      const files = (project.files ?? {}) as Record<string, string>;
      for (const g of resx) {
        const file = g.targetFile?.split("/").pop();
        if (file && typeof files[file] === "string") bases[g.name] = files[file]!;
      }
      for (const [group, keys] of Object.entries((project.records ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!resx.some((g) => g.name === group) || !keys || typeof keys !== "object") continue;
        for (const [key, r] of Object.entries(keys)) {
          const rec = parseRecord(r);
          if (rec) put(group, key, rec);
        }
      }
    }
    if (draft?.locale === locale && Array.isArray(draft.edits)) {
      for (const e of draft.edits as DraftEdit[]) {
        if (typeof e?.group === "string" && typeof e.key === "string" && isState(e.state) && resx.some((g) => g.name === e.group)) {
          edits.push({ group: e.group, key: e.key, state: e.state, record: parseRecord(e.record) });
        }
      }
    }
  }

  // ---- MuBMD-editor 2.x (Vietnamese only) ----
  if (ws.items && locale === "vi") {
    const dir = st.join(st.dirname(ws.items.dir), `${st.basename(ws.items.dir)}.mubmd`);
    const project = json(await tryReadText(st, st.join(dir, "project.json")));
    const draft = json(await tryReadText(st, st.join(dir, "draft.json")));
    const items = groups.filter((g) => g.source === "items");
    const at = (slot: number): [SourceGroup, string] | null => {
      if (!Number.isInteger(slot)) return null;
      const g = items.find((x) => x.itemType === Math.floor(slot / MAX_ITEM_INDEX));
      const key = String(slot % MAX_ITEM_INDEX);
      return g && g.en(key) !== null ? [g, key] : null;
    };
    const ok = project?.version === 2 && typeof project.records === "object";
    if (ok || draft?.version === 2) from.push(rel(dir));
    if (ok) {
      // The old tool hashed every Vietnamese name: [[slot, name]...] in slot order.
      const names: [number, string][] = [];
      for (const g of [...items].sort((a, b) => (a.itemType ?? 0) - (b.itemType ?? 0))) {
        for (const key of g.keys()) {
          const v = g.saved(key)?.value;
          if (v) names.push([(g.itemType ?? 0) * MAX_ITEM_INDEX + Number(key), v]);
        }
      }
      const same = sha1(new TextEncoder().encode(JSON.stringify(names))) === project.namesSha1;
      for (const g of items) bases[g.name] = same ? g.baseHash() : CHANGED;
      for (const [slot, r] of Object.entries(project.records as Record<string, unknown>)) {
        const target = at(Number(slot));
        const rec = parseRecord(r);
        if (target && rec) put(target[0].name, target[1], rec);
      }
    }
    if (draft?.version === 2 && Array.isArray(draft.slots)) {
      for (const d of draft.slots as { slot: number; name?: string; record?: unknown }[]) {
        const target = at(d?.slot);
        if (!target) continue;
        const [g, key] = target;
        const state: EntryState = typeof d.name === "string" ? (d.name ? { value: d.name, comment: null } : null) : g.saved(key);
        const record = d.record === undefined ? (records[g.name]?.[key] ?? null) : parseRecord(d.record);
        edits.push({ group: g.name, key, state, record });
      }
    }
  }

  if (!from.length) return null;
  await writeProject(st, root, { version: 1, locale, bases, records });
  if (edits.length && !(await st.exists(draftPath(st, root, locale)))) {
    await writeDraft(st, root, { version: 1, locale, savedAt: now.toISOString(), edits });
  }
  return { from, records: count, draftEdits: edits.length };
}
