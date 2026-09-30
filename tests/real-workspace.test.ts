// Opens a real MuMain checkout as a workspace (both sources):  MUMAIN_DIR=/path/to/MuMain bun test
// Skipped without it (as in CI). Nothing is written to the checkout (see ReadOnlyDisk): edits are
// made and reverted in memory, and the file the save would write is compared with the original.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { NodeStorage } from "../src/server/nodeStorage";
import { Session } from "../src/session/session";

// Reads the checkout, keeps every write (the draft) in memory: the checkout is never touched.
class ReadOnlyDisk extends NodeStorage {
  private mem = new Map<string, Uint8Array>();
  override async read(p: string) {
    return this.mem.get(p) ?? super.read(p);
  }
  override async exists(p: string) {
    return this.mem.has(p) || super.exists(p);
  }
  override async writeAtomic(p: string, bytes: Uint8Array) {
    this.mem.set(p, bytes);
  }
  override async remove(p: string) {
    this.mem.delete(p);
  }
  override async rename(from: string, to: string) {
    const b = this.mem.get(from);
    if (b) this.mem.set(to, b);
    this.mem.delete(from);
  }
}

const MUMAIN = process.env.MUMAIN_DIR ?? "";
const available = MUMAIN !== "" && fs.existsSync(path.join(MUMAIN, "src", "Localization")) && fs.existsSync(path.join(MUMAIN, "src", "bin", "Data", "Items"));

describe.skipIf(!available)(`real checkout ${MUMAIN || "(MUMAIN_DIR not set)"}`, () => {
  test("found both sources; every item file is a group", async () => {
    const s = new Session(new ReadOnlyDisk(), undefined, "darwin");
    const listing = await s.scan(MUMAIN);
    expect(listing.resx?.rel).toBe("src/Localization");
    expect([listing.items?.rel, listing.items?.layout]).toEqual(["src/bin/Data/Items", "source"]);
    // Picking src/Localization finds the same workspace.
    expect((await s.scan(path.join(MUMAIN, "src", "Localization"))).path).toBe(path.resolve(MUMAIN));

    await s.openFolder(MUMAIN, "vi", null, { create: true });
    const { groups, rows } = s.rows();
    const items = groups.filter((g) => g.source === "items");
    expect(items.length).toBe(listing.items!.files.length);
    expect(items.reduce((n, g) => n + g.progress.total, 0)).toBeGreaterThan(900);
    expect(groups.some((g) => g.name === "Game")).toBe(true);
    const sword1 = rows.find((r) => groups[r[0]]!.name === "Items.Sword" && r[1] === "1")!;
    expect(sword1[2]).toBe("Short Sword");
  });

  test("an item edit writes exactly one name; undoing it writes nothing", async () => {
    const s = new Session(new ReadOnlyDisk(), undefined, "darwin");
    await s.openFolder(MUMAIN, "vi", null, { create: true });
    const swordsPath = path.join(MUMAIN, "src", "bin", "Data", "Items", "Group00_Sword.json");
    const original = fs.readFileSync(swordsPath, "utf-8");
    await s.edit("Items.Sword", "1", "Đoản Kiếm", "Test");
    // What the save would write (planWrite is what save() uses, without touching the disk).
    const g = (s as unknown as { groups: { name: string; planWrite(k: string[]): { text: string } }[] }).groups.find((x) => x.name === "Items.Sword")!;
    const text = g.planWrite(["1"]).text;
    const changed = text.split("\n").filter((l, i) => l !== original.split("\n")[i]);
    expect(text.split("\n").length - original.split("\n").length).toBe(1); // one "vi" line added
    expect(changed.some((l) => l.includes('"vi": "Đoản Kiếm"'))).toBe(true);
    await s.undo();
    expect(g.planWrite(["1"]).text).toBe(original);
    expect(s.status().dirtyCount).toBe(0);
  });
});
