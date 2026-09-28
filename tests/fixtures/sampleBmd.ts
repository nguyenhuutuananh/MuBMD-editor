// sampleBmd.ts - Synthetic Item.bmd for tests and development, so no game data has to be committed.
// Names come from item-names.tsv (the translated names); every other byte of a named record is
// deterministic filler standing in for item stats, so "bytes outside the name are preserved"
// checks still mean something. XOR encoding and checksum are the real ones.

import * as fs from "node:fs";
import * as path from "node:path";
import { BODY_SIZE, NAME_LEN, RECORD_SIZE, buxConvert, genCheckSum2, parseDelimited } from "../../src/core";

const NAMES = path.join(import.meta.dir, "item-names.tsv");

export function buildSampleBmd(): Uint8Array {
  const body = new Uint8Array(BODY_SIZE);
  const enc = new TextEncoder();
  let seed = 0x2468ace1;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  };
  for (const [type, index, name] of parseDelimited(fs.readFileSync(NAMES, "utf-8")).slice(1)) {
    if (!name) continue;
    const off = (Number(type) * 512 + Number(index)) * RECORD_SIZE;
    body.set(enc.encode(name), off); // raw cell, so names keep their exact bytes
    for (let i = NAME_LEN; i < RECORD_SIZE; i++) body[off + i] = next();
  }
  const encoded = buxConvert(body);
  const out = new Uint8Array(BODY_SIZE + 4);
  out.set(encoded, 0);
  new DataView(out.buffer).setUint32(BODY_SIZE, genCheckSum2(encoded), true);
  return out;
}

// Write the sample to `target` (default: tests/fixtures/.generated/Item.bmd) and return its path.
export function writeSampleBmd(target = path.join(import.meta.dir, ".generated", "Item.bmd")): string {
  const bytes = buildSampleBmd();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!current || !Buffer.from(bytes).equals(current)) fs.writeFileSync(target, bytes);
  return target;
}

export const SAMPLE_BMD = writeSampleBmd();
