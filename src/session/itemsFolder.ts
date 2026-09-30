// itemsFolder.ts - Find MuMain's item data folder (Data/Items) from the folder the user picked.
//
// The user picks the game folder; where Data/Items is depends on how the client was built:
//   Windows / Linux   <game>/Data/Items                         (next to Main.exe / Main)
//   macOS             <game>/Main.app/Contents/MacOS/Data/Items  (inside the app bundle)
//   MuMain source     <repo>/src/bin/Data/Items                  (the build copies it next to Main)
// Picking Data/Items itself, Data, or the .app bundle works too. When a folder holds several
// layouts (e.g. a macOS and a Windows build side by side), the one of this computer's OS wins.

import { AppError } from "../core/errors";
import { looksLikeItemFile } from "../core/itemData";
import type { Storage } from "./storage";

export type Platform = "darwin" | "win32" | "linux" | "other";

// How the item folder was found (shown in the UI so the user can check it is the right one).
export type ItemsLayout = "items" | "data" | "source" | "app" | "game";

export interface ItemsFolder {
  root: string; // the folder the user picked
  dir: string; // the item data folder
  layout: ItemsLayout;
}

export class ItemsNotFoundError extends AppError {
  constructor(folder: string) {
    super("items-not-found", `No item data (Data/Items/Group00_Sword.json ...) was found in ${folder}.`, { folder });
  }
}

export const hostPlatform = (p: string): Platform => (p === "darwin" || p === "win32" || p === "linux" ? p : "other");

async function hasItemFiles(st: Storage, dir: string): Promise<boolean> {
  return (await st.list(dir)).some(looksLikeItemFile);
}

export async function findItemsFolder(st: Storage, picked: string, platform: Platform): Promise<ItemsFolder> {
  const root = st.resolve(picked);
  const at = (...parts: string[]) => st.join(root, ...parts);
  const found = (dir: string, layout: ItemsLayout): ItemsFolder => ({ root, dir, layout });

  // The folder itself, or Data (clear choices, whatever the OS).
  if (await hasItemFiles(st, root)) return found(root, "items");
  if (await hasItemFiles(st, at("Items"))) return found(at("Items"), "data");
  // A MuMain checkout: the source data, not a build output that the next build overwrites.
  if (await hasItemFiles(st, at("src", "bin", "Data", "Items"))) return found(at("src", "bin", "Data", "Items"), "source");

  const plain = async () => ((await hasItemFiles(st, at("Data", "Items"))) ? found(at("Data", "Items"), "game") : null);
  const bundle = async () => {
    const inBundle = (...parts: string[]) => st.join(root, ...parts, "Contents", "MacOS", "Data", "Items");
    if (await hasItemFiles(st, inBundle())) return found(inBundle(), "app"); // picked the .app itself
    const apps = (await st.listDirs(root))
      .filter((n) => /\.app$/i.test(n))
      .sort((a, b) => Number(b.toLowerCase() === "main.app") - Number(a.toLowerCase() === "main.app") || a.localeCompare(b));
    for (const app of apps) if (await hasItemFiles(st, inBundle(app))) return found(inBundle(app), "app");
    return null;
  };
  const order = platform === "darwin" ? [bundle, plain] : [plain, bundle];
  for (const probe of order) {
    const r = await probe();
    if (r) return r;
  }
  throw new ItemsNotFoundError(root);
}
