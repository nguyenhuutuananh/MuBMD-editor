// The same Session on an in-memory Storage: what the browser build will run on.
import { beforeEach, describe, expect, test } from "bun:test";
import { ItemBmd } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { ConflictError, Session } from "../src/session/session";
import { readDraft, stamp } from "../src/session/sidecar";
import { buildSampleBmd } from "./fixtures/sampleBmd";

const ORIGINAL = buildSampleBmd();
const FILE = "/work/Data/Local/Item.bmd";
let st: MemoryStorage;
let clock: number;
const now = () => new Date(clock);

beforeEach(() => {
  st = new MemoryStorage({ [FILE]: ORIGINAL });
  clock = Date.UTC(2026, 8, 28, 4, 0, 0);
});

async function opened() {
  const s = new Session(st, now);
  await s.open(FILE);
  return s;
}
const disk = async (slot: number) => ItemBmd.parse(await st.read(FILE)).getName(slot).text;

describe("Session on MemoryStorage", () => {
  test("edit, save: file + backup + log + project.json written through the Storage", async () => {
    const s = await opened();
    await s.edit(0, "Chùy Mới", "An");
    await s.setStatus([1], "reviewed", "An");
    const r = await s.save();
    expect(r.savedCount).toBe(2);
    expect(await disk(0)).toBe("Chùy Mới");
    expect([...st.files.keys()].sort()).toEqual([
      "/work/Data/Local/Item.bmd",
      `/work/Data/Local/Item.bmd.mubmd/backups/Item-${stamp(now())}.bmd`, // local time, like on the desktop
      "/work/Data/Local/Item.bmd.mubmd/changes.tsv",
      "/work/Data/Local/Item.bmd.mubmd/project.json",
    ].sort());
    expect(Buffer.from(await st.read(r.backupPath!)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  test("draft survives a new Session (= reloading the page)", async () => {
    await (await opened()).edit(0, "Nháp", "An");
    expect((await readDraft(st, FILE))?.slots.map((x) => x.slot)).toEqual([0]);
    const s2 = await opened();
    expect(s2.draftInfo()?.count).toBe(1);
    await s2.restoreDraft();
    expect(s2.item(0)[1]).toBe("Nháp");
  });

  test("conflict when the file changes underneath", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(1, "Khác");
    await st.writeAtomic(FILE, other.toBytes());
    await expect(s.save()).rejects.toThrow(ConflictError);
  });

  test("a locked file (game client running) reports file-locked and keeps the edits", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    st.locked.add(FILE);
    await expect(s.save()).rejects.toMatchObject({ code: "file-locked", params: { file: "Item.bmd" } });
    expect(s.status().dirtyCount).toBe(1);
    st.locked.clear();
    await s.save();
    expect(await disk(0)).toBe("A");
  });

  test("missing file -> file-not-found", async () => {
    await expect(new Session(st, now).open("/nope/Item.bmd")).rejects.toMatchObject({ code: "file-not-found" });
  });
});

describe("concurrent calls run one at a time", () => {
  test("edits fired without awaiting apply in order; the draft reflects the final state", async () => {
    const s = await opened();
    const done = await Promise.all([s.edit(0, "A", "An"), s.edit(0, "B", "An"), s.edit(1, "C", "An"), s.setStatus([2], "reviewed", "An")]);
    expect(done.map((r) => r.status.dirtyCount)).toEqual([1, 1, 2, 3]);
    expect(s.item(0)[1]).toBe("B");
    const draft = await readDraft(st, FILE);
    expect(draft?.slots.map((x) => [x.slot, x.name ?? null])).toEqual([
      [0, "B"],
      [1, "C"],
      [2, null],
    ]);
  });

  test("an edit queued behind a save lands after it (dirty again)", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    const [saved, edited] = await Promise.all([s.save(), s.edit(1, "B", "An")]);
    expect(saved.savedCount).toBe(1);
    expect(edited.status.dirtyCount).toBe(1);
    expect(await disk(0)).toBe("A");
    expect(await disk(1)).not.toBe("B");
  });
});
