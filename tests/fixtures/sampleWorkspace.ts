// sampleWorkspace.ts - A small MuMain checkout for tests: the sample Localization folder
// (sampleLocalization.ts) in src/Localization and the sample item files (sampleItems.ts) in
// src/bin/Data/Items, as a { path: bytes } map for MemoryStorage (or written to disk).

import * as fs from "node:fs";
import * as path from "node:path";
import { sampleBytes } from "./sampleLocalization";
import { sampleFiles } from "./sampleItems";

const enc = new TextEncoder();

export const RESX_REL = "src/Localization";
export const ITEMS_REL = "src/bin/Data/Items";

// Files of a checkout at `root` (default "/mu"): resx and / or items.
export function sampleCheckout(root = "/mu", parts: { resx?: boolean; items?: boolean; itemsRel?: string } = {}): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (parts.resx !== false) for (const [n, b] of Object.entries(sampleBytes())) out[`${root}/${RESX_REL}/${n}`] = b;
  if (parts.items !== false) for (const [n, t] of Object.entries(sampleFiles())) out[`${root}/${parts.itemsRel ?? ITEMS_REL}/${n}`] = enc.encode(t);
  return out;
}

// Write a checkout to disk under `dir`; returns `dir`.
export function writeSampleCheckout(dir: string): string {
  for (const [p, b] of Object.entries(sampleCheckout(""))) {
    const file = path.join(dir, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, b);
  }
  return dir;
}
