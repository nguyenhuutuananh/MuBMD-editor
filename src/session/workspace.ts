// workspace.ts - What a picked folder holds: MuMain's Localization string tables (resx), its item
// data (items), or both.
//
//   a MuMain checkout      <repo>/src/Localization + <repo>/src/bin/Data/Items    both
//   src or Localization    the same checkout, found from inside it                both
//   a game folder          Data/Items (Windows / Linux) or Main.app/.../Data/Items (macOS)   items
//   Data/Items             items
//   a lone Localization    (not inside a checkout)                                resx
// A released game has no .resx files: they are compiled into the client by MuMain's build.
// The workspace root is where the side data lives (.mumain-translator/): the checkout, else the
// picked folder.

import { AppError, DEFAULT_LOCALE, compareLocales, groupResxFiles } from "../core";
import type { WorkspaceListing } from "../shared/api";
import { type ItemsFolder, ItemsNotFoundError, type Platform, findItemsFolder } from "./itemsFolder";
import { itemLocales } from "./sources/itemsGroup";
import type { Storage } from "./storage";

export interface Workspace {
  root: string;
  resx: { dir: string; rel: string } | null;
  items: (ItemsFolder & { rel: string }) | null;
}

// `dir` relative to `root` with "/" separators ("" when they are the same).
function relative(st: Storage, root: string, dir: string): string {
  const parts: string[] = [];
  for (let p = dir; p !== root; p = st.dirname(p)) {
    if (st.dirname(p) === p || parts.length > 12) return dir; // not below root
    parts.unshift(st.basename(p));
  }
  return parts.join("/");
}

const hasResx = async (st: Storage, dir: string) => groupResxFiles(await st.list(dir)).groups.length > 0;

export async function findWorkspace(st: Storage, picked: string, platform: Platform): Promise<Workspace> {
  const p = st.resolve(picked);
  if (!(await st.isDirectory(p))) {
    if (await st.exists(p)) throw new AppError("not-a-folder", `${picked} is a file, not a folder.`, { path: picked });
    throw new AppError("file-not-found", `No such folder: ${picked}`, { path: picked });
  }

  // Localization: the folder itself, <src>/Localization, or <repo>/src/Localization.
  let resxDir: string | null = null;
  let root = p;
  const up = (d: string, n: number): string => (n === 0 ? d : up(st.dirname(d), n - 1));
  if (await hasResx(st, st.join(p, "src", "Localization"))) resxDir = st.join(p, "src", "Localization");
  else if (await hasResx(st, st.join(p, "Localization"))) {
    resxDir = st.join(p, "Localization");
    if (st.basename(p).toLowerCase() === "src") root = up(p, 1);
  } else if (await hasResx(st, p)) {
    resxDir = p;
    if (st.basename(up(p, 1)).toLowerCase() === "src") root = up(p, 2);
  }

  let items: ItemsFolder | null = null;
  try {
    items = await findItemsFolder(st, root, platform);
  } catch (e) {
    if (!(e instanceof ItemsNotFoundError)) throw e;
  }
  if (!resxDir && !items) throw new AppError("nothing-to-translate", `Neither Localization .resx files nor item data in ${picked}.`, { path: p });

  return {
    root,
    resx: resxDir ? { dir: resxDir, rel: relative(st, root, resxDir) } : null,
    items: items ? { ...items, rel: relative(st, root, items.dir) } : null,
  };
}

// The workspace as found on disk, before choosing a locale.
export async function listWorkspace(st: Storage, ws: Workspace): Promise<WorkspaceListing> {
  const perLocale = new Map<string, number>();
  const count = (locales: string[]) => {
    for (const l of new Set(locales)) perLocale.set(l, (perLocale.get(l) ?? 0) + 1);
  };

  let resx: WorkspaceListing["resx"] = null;
  if (ws.resx) {
    const listing = groupResxFiles(await st.list(ws.resx.dir));
    for (const g of listing.groups) count(g.locales);
    resx = {
      dir: ws.resx.dir,
      rel: ws.resx.rel,
      groups: listing.groups.map((g) => ({ name: g.name, locales: g.locales, hasDefault: g.hasDefault })),
      skipped: listing.skipped,
    };
  }

  let items: WorkspaceListing["items"] = null;
  if (ws.items) {
    const files = await itemLocales(st, ws.items.dir);
    for (const f of files) count([DEFAULT_LOCALE, ...f.locales]);
    items = { dir: ws.items.dir, rel: ws.items.rel, layout: ws.items.layout, files };
  }

  return {
    path: ws.root,
    resx,
    items,
    locales: [...perLocale.keys()].sort(compareLocales).map((code) => ({ code, groups: perLocale.get(code)! })),
  };
}
