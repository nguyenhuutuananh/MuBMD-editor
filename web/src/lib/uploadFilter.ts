// uploadFilter.ts - Which files of a folder chosen in the fallback web build are read (a checkout
// or a game folder has thousands of others). Pure logic.

import { looksLikeItemFile, parseResxFileName } from "../../../src/core";

// Only the files this tool translates are read from the chosen folder (a checkout or a game folder
// has thousands of others): <Group>.<locale>.resx directly in the folder or in a "Localization"
// folder, and the item files (*.json directly in a folder named "Items", or named like
// Group00_Sword.json - not the model files in Items/Models).
export function isTranslatableUpload(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1]!;
  const parent = (parts[parts.length - 2] ?? "").toLowerCase();
  if (parts.some((p) => p === ".git" || p === ".mumain-translator" || p === "node_modules")) return false;
  if (parseResxFileName(name)) return parts.length === 2 || parent === "localization";
  if (!/\.json$/i.test(name)) return false;
  return parent === "items" || (looksLikeItemFile(name) && parent !== "models");
}
