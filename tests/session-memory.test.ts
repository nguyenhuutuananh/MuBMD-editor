// The same Session on an in-memory Storage: what the browser build will run on.
import { beforeEach, describe, expect, test } from "bun:test";
import { ItemData } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { ConflictError, Session } from "../src/session/session";
import { readDraft, stamp } from "../src/session/sidecar";
import { sampleFiles } from "./fixtures/sampleItems";

const enc = new TextEncoder();
const FILES = sampleFiles();
const GAME = "/work/MU";
const ITEMS = `${GAME}/Main.app/Contents/MacOS/Data/Items`;
const SWORDS = `${ITEMS}/Group00_Sword.json`;
let st: MemoryStorage;
let clock: number;
const now = () => new Date(clock);

beforeEach(() => {
  st = new MemoryStorage(Object.fromEntries(Object.entries(FILES).map(([n, t]) => [`${ITEMS}/${n}`, enc.encode(t)])));
  clock = Date.UTC(2026, 8, 28, 4, 0, 0);
});

async function opened(platform: "darwin" | "win32" = "darwin") {
  const s = new Session(st, now, platform);
  await s.open(GAME);
  return s;
}
const swords = async () => ItemData.parse([{ name: "Group00_Sword.json", text: new TextDecoder().decode(await st.read(SWORDS)) }]);
const disk = async (slot: number) => (await swords()).getName(slot);

describe("Session on MemoryStorage", () => {
  test("finds the item folder inside the app bundle", async () => {
    const s = await opened();
    expect(s.file).toMatchObject({ path: ITEMS, root: GAME, layout: "app", fileName: "Main.app/Contents/MacOS/Data/Items" });
  });

  test("edit, save: file + backup + log + project.json written through the Storage", async () => {
    const s = await opened();
    await s.edit(1, "Đoản Đao", "An");
    await s.setStatus([2], "reviewed", "An");
    const r = await s.save();
    expect(r.savedCount).toBe(2);
    expect(await disk(1)).toBe("Đoản Đao");
    const side = [...st.files.keys()].filter((k) => !k.startsWith(`${ITEMS}/`)).sort();
    expect(side).toEqual([
      `${ITEMS}.mubmd/backups/Group00_Sword-${stamp(now())}.json`, // local time, like on the desktop
      `${ITEMS}.mubmd/changes.tsv`,
      `${ITEMS}.mubmd/project.json`,
    ]);
    expect(new TextDecoder().decode(await st.read(`${ITEMS}.mubmd/backups/Group00_Sword-${stamp(now())}.json`))).toBe(FILES["Group00_Sword.json"]!);
  });

  test("draft survives a new Session (= reloading the page)", async () => {
    await (await opened()).edit(1, "Nháp", "An");
    expect((await readDraft(st, ITEMS))?.slots.map((x) => x.slot)).toEqual([1]);
    const s2 = await opened();
    expect(s2.draftInfo()?.count).toBe(1);
    await s2.restoreDraft();
    expect(s2.item(1)[1]).toBe("Nháp");
  });

  test("conflict when a file changes underneath", async () => {
    const s = await opened();
    await s.edit(1, "A", "An");
    const other = await swords();
    other.setName(3, "Khác");
    await st.writeAtomic(SWORDS, enc.encode(other.changedFiles()[0]!.text));
    await expect(s.save()).rejects.toThrow(ConflictError);
  });

  test("a locked file (game client running) reports file-locked and keeps the edits", async () => {
    const s = await opened();
    await s.edit(1, "A", "An");
    st.locked.add(SWORDS);
    await expect(s.save()).rejects.toMatchObject({ code: "file-locked", params: { file: "Group00_Sword.json" } });
    expect(s.status().dirtyCount).toBe(1);
    st.locked.clear();
    await s.save();
    expect(await disk(1)).toBe("A");
  });

  test("missing folder -> items-not-found", async () => {
    await expect(new Session(st, now).open("/nope")).rejects.toMatchObject({ code: "items-not-found", params: { folder: "/nope" } });
  });
});

describe("concurrent calls run one at a time", () => {
  test("edits fired without awaiting apply in order; the draft reflects the final state", async () => {
    const s = await opened();
    const done = await Promise.all([s.edit(1, "A", "An"), s.edit(1, "B", "An"), s.edit(3, "C", "An"), s.setStatus([2], "reviewed", "An")]);
    expect(done.map((r) => r.status.dirtyCount)).toEqual([1, 1, 2, 3]);
    expect(s.item(1)[1]).toBe("B");
    const draft = await readDraft(st, ITEMS);
    expect(draft?.slots.map((x) => [x.slot, x.name ?? null])).toEqual([
      [1, "B"],
      [2, null],
      [3, "C"],
    ]);
  });

  test("an edit queued behind a save lands after it (dirty again)", async () => {
    const s = await opened();
    await s.edit(1, "A", "An");
    const [saved, edited] = await Promise.all([s.save(), s.edit(3, "B", "An")]);
    expect(saved.savedCount).toBe(1);
    expect(edited.status.dirtyCount).toBe(1);
    expect(await disk(1)).toBe("A");
    expect(await disk(3)).not.toBe("B");
  });
});
