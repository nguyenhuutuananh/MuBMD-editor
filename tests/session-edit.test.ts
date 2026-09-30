import { describe, expect, test } from "bun:test";
import { AppError, type ErrorCode, parseResx, resxValues } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { ConflictError, Session } from "../src/session/session";
import { ROW_DIRTY, ROW_KEEP, type RowTuple } from "../src/shared/api";
import { SAMPLE_FILES, sampleBytes } from "./fixtures/sampleLocalization";

const DIR = "/mu/src/Localization";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let clock = 0;
function setup() {
  const st = new MemoryStorage(Object.fromEntries(Object.entries(sampleBytes()).map(([n, b]) => [`${DIR}/${n}`, b])));
  clock = 0;
  // 2026-09-29 10:00:00 local time + 1 s per call
  const s = new Session(st, () => new Date(2026, 8, 29, 10, 0, clock++));
  return { st, s };
}

async function opened() {
  const t = setup();
  await t.s.openFolder(DIR, "vi");
  return t;
}

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return undefined;
}

const file = (st: MemoryStorage, name: string) => dec(st.files.get(`${DIR}/${name}`)!);
const valueIn = (st: MemoryStorage, name: string, key: string) => resxValues(parseResx(file(st, name))).get(key);
const row = (rows: RowTuple[], key: string) => rows.find((r) => r[1] === key)!;

describe("edit", () => {
  test("changes the value in memory; the row is dirty with the saved value", async () => {
    const { s, st } = await opened();
    const res = await s.edit("Game", "Event", "Sự kiện mới", "An");
    expect(res.changed.map((r) => [r[1], r[3], r[9], r[10]])).toEqual([["Event", "Sự kiện mới", ROW_DIRTY, "Sự kiện"]]);
    expect(res.status).toEqual({ dirtyCount: 1, canUndo: true, canRedo: false });
    expect(res.groups[2]!.dirty).toBe(1);
    expect(file(st, "Game.vi.resx")).toBe(SAMPLE_FILES["Game.vi.resx"]!); // nothing written yet
  });

  test("the row's checks follow the edit", async () => {
    const { s } = await opened();
    const bad = await s.edit("Game", "Level %d", "Cấp", "An");
    expect(bad.changed[0]![5].map((i) => i[0])).toEqual(["printf-mismatch"]);
    const good = await s.edit("Game", "Level %d", "Cấp %d", "An");
    expect(good.changed[0]![5]).toEqual([]);
  });

  test("a new key gets the en comment (legacy_id); text is NFC", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Level %d", "Cấp %d", "An");
    const r = row(s.rows().rows, "Level %d");
    expect(r[3]).toBe("Cấp %d");
    await s.save();
    expect(valueIn(st, "Game.vi.resx", "Level %d")).toMatchObject({ value: "Cấp %d", legacyIds: [11] });
  });

  test("editing back to the saved text is no longer dirty", async () => {
    const { s } = await opened();
    await s.edit("Game", "Event", "X", "An");
    const res = await s.edit("Game", "Event", "Sự kiện", "An");
    expect(res.status.dirtyCount).toBe(0);
    expect(res.changed[0]![9]).toBe(0);
  });

  test('"" removes the translation; unknown keys are refused', async () => {
    const { s } = await opened();
    const res = await s.edit("Game", "Event", "", "An");
    expect([res.changed[0]![3], res.changed[0]![9]]).toEqual([null, ROW_DIRTY]);
    expect(await codeOf(s.edit("Game", "Nope", "x", "An"))).toBe("not-editable");
    expect(await codeOf(s.edit("Nope", "Event", "x", "An"))).toBe("not-editable");
    // an extra key can be removed, not given new text
    expect(await codeOf(s.edit("Game", "Removed key", "x", "An"))).toBe("not-editable");
    expect((await s.edit("Game", "Removed key", null, "An")).changed[0]![3]).toBeNull();
  });

  test("a group without a file yet: the file is created on save", async () => {
    const { s, st } = await opened();
    await s.edit("Dialog", "Text_1", "Xin chào! Ta là Baz, người giữ kho.", "An");
    const saved = await s.save();
    expect(saved.created).toEqual(["src/Localization/Dialog.vi.resx"]);
    expect(valueIn(st, "Dialog.vi.resx", "Text_1")).toMatchObject({ value: "Xin chào! Ta là Baz, người giữ kho.", legacyIds: [1] });
    expect(file(st, "Dialog.vi.resx").startsWith('<?xml version="1.0" encoding="utf-8"?>\n<root>\n  <resheader')).toBe(true);
    expect(s.rows().groups[0]!.file).toBe("src/Localization/Dialog.vi.resx");
    expect(s.open!.folder.locales.find((l) => l.code === "vi")!.groups).toBe(3);
  });
});

describe("keep", () => {
  test("keep = en text + mark in the comment; editing a translation removes the mark", async () => {
    const { s, st } = await opened();
    let res = await s.setKeep("Game", "Chaos Castle", true, "An");
    expect([res.changed[0]![3], res.changed[0]![9] & ROW_KEEP, res.changed[0]![5]]).toEqual(["Chaos Castle", ROW_KEEP, []]);
    await s.save();
    expect(valueIn(st, "Game.vi.resx", "Chaos Castle")).toMatchObject({ value: "Chaos Castle", comment: "legacy_id=12; keep" });

    res = await s.edit("Game", "Chaos Castle", "Lâu Đài Hỗn Loạn", "An");
    expect(res.changed[0]![9] & ROW_KEEP).toBe(0);
    await s.save();
    expect(valueIn(st, "Game.vi.resx", "Chaos Castle")!.comment).toBe("legacy_id=12");
  });

  test("keep on an existing same-as-en line; un-keep keeps the text", async () => {
    const { s } = await opened();
    let res = await s.setKeep("Game", "Gulim", true, "An");
    expect(res.changed[0]![5]).toEqual([]); // no more same-as-en
    expect(res.groups[2]!.progress).toMatchObject({ sameAsEn: 0, kept: 1 });
    res = await s.setKeep("Game", "Gulim", false, "An");
    expect([res.changed[0]![3], res.changed[0]![9]]).toEqual(["Gulim", 0]); // back to the saved state
  });
});

describe("undo / redo / revert", () => {
  test("undo and redo, across a save", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "A", "An");
    await s.edit("Game", "Event", "B", "An");
    expect((await s.undo()).changed[0]![3]).toBe("A");
    expect((await s.redo()).changed[0]![3]).toBe("B");
    await s.save();
    const res = await s.undo();
    expect([res.changed[0]![3], res.status.dirtyCount]).toEqual(["A", 1]); // undo after save = a new change
    expect(valueIn(st, "Game.vi.resx", "Event")!.value).toBe("B");
  });

  test("undo of an added key removes it again, byte for byte", async () => {
    const { s } = await opened();
    await s.edit("Game", "Level %d", "Cấp %d", "An");
    const res = await s.undo();
    expect(res.status.dirtyCount).toBe(0);
    expect(res.changed[0]![3]).toBeNull();
  });

  test("revert goes back to the file", async () => {
    const { s } = await opened();
    await s.edit("Game", "Event", "A", "An");
    await s.setKeep("Game", "Gulim", true, "An");
    const res = await s.revert("Game", "Event");
    expect([res.changed[0]![3], res.status.dirtyCount]).toEqual(["Sự kiện", 1]);
  });
});

describe("save", () => {
  test("writes only the changed files, with a backup and a change log", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "Sự kiện mới", "An");
    await s.edit("Game", "Level %d", "Cấp %d", "Bình");
    const res = await s.save();
    expect(res).toMatchObject({ files: ["src/Localization/Game.vi.resx"], created: [], savedCount: 2 });
    expect(res.backups).toHaveLength(1);
    expect(res.backups[0]).toMatch(/^\/mu\/.mumain-translator\/backups\/Game.vi-20260929-1000\d\d.resx$/);
    expect(dec(st.files.get(res.backups[0]!)!)).toBe(SAMPLE_FILES["Game.vi.resx"]!);
    expect(file(st, "Editor.vi.resx")).toBe(SAMPLE_FILES["Editor.vi.resx"]!);

    // only the edited lines differ
    const before = SAMPLE_FILES["Game.vi.resx"]!.split("\n");
    const after = file(st, "Game.vi.resx").split("\n");
    expect(after.length - before.length).toBe(4); // the new entry: data, value, comment (legacy_id from en), /data
    expect(after.filter((l) => !before.includes(l))).toEqual([
      "    <value>Sự kiện mới</value>",
      '  <data name="Level %d" xml:space="preserve">',
      "    <value>Cấp %d</value>",
      "    <comment>legacy_id=11</comment>",
    ]);

    const log = dec(st.files.get(res.logPath)!).split("\n");
    expect(log[0]).toBe("Time\tTranslator\tFile\tKey\tOldValue\tNewValue");
    expect(log.slice(1, 3).map((l) => l.split("\t").slice(1))).toEqual([
      ["An", "src/Localization/Game.vi.resx", "Event", "Sự kiện", "Sự kiện mới"],
      ["Bình", "src/Localization/Game.vi.resx", "Level %d", "-", "Cấp %d"],
    ]);
    expect(s.status().dirtyCount).toBe(0);
    expect(await st.exists(`/mu/.mumain-translator/draft-vi.json`)).toBe(false);
  });

  test("nothing to save", async () => {
    const { s } = await opened();
    expect((await s.save()).files).toEqual([]);
  });

  test("a file changed on disk: conflict, then merge (rebase) or overwrite", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "Sự kiện mới", "An");
    // someone else changed another key, and the same key, of Game.vi.resx
    const theirs = SAMPLE_FILES["Game.vi.resx"]!.replace("Bạn đã bị ngắt kết nối khỏi máy chủ.", "Mất kết nối.");
    st.files.set(`${DIR}/Game.vi.resx`, enc(theirs));
    const err = await s.save().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).files).toEqual(["src/Localization/Game.vi.resx"]);

    const rb = await s.rebase();
    expect(rb).toEqual({ changedFiles: ["src/Localization/Game.vi.resx"], conflicts: [] });
    expect(s.status().dirtyCount).toBe(1);
    await s.save();
    expect(valueIn(st, "Game.vi.resx", "Event")!.value).toBe("Sự kiện mới");
    expect(valueIn(st, "Game.vi.resx", "You have been disconnected from the server.")!.value).toBe("Mất kết nối.");

    // same key changed on both sides: ours kept, reported
    await s.edit("Game", "Event", "Ours", "An");
    st.files.set(`${DIR}/Game.vi.resx`, enc(file(st, "Game.vi.resx").replace("Sự kiện mới", "Theirs")));
    expect((await s.rebase()).conflicts).toEqual([{ group: "Game", key: "Event" }]);
    expect(row(s.rows().rows, "Event")[3]).toBe("Ours");

    // force
    st.files.set(`${DIR}/Game.vi.resx`, enc(file(st, "Game.vi.resx").replace("Mất kết nối.", "X")));
    await s.save({ force: true });
    expect(valueIn(st, "Game.vi.resx", "You have been disconnected from the server.")!.value).toBe("Mất kết nối.");
  });

  test("the game holding the file", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "A", "An");
    st.locked.add(`${DIR}/Game.vi.resx`);
    expect(await codeOf(s.save())).toBe("file-locked");
    expect(s.status().dirtyCount).toBe(1);
  });
});

describe("draft", () => {
  test("every edit writes the draft; reopening offers it; restore is one undo step", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "Nháp", "An");
    await s.setKeep("Game", "Gulim", true, "An");
    const draft = JSON.parse(dec(st.files.get(`/mu/.mumain-translator/draft-vi.json`)!));
    expect(draft.edits.map((e: { key: string }) => e.key).sort()).toEqual(["Event", "Gulim"]);

    const s2 = new Session(st, () => new Date(2026, 8, 29, 11, 0, 0));
    await s2.openFolder(DIR, "vi");
    expect(s2.rows().draft).toMatchObject({ count: 2, translators: ["An"] });
    const res = await s2.restoreDraft();
    expect([res.skipped, res.status.dirtyCount]).toEqual([0, 2]);
    expect(row(s2.rows().rows, "Event")[3]).toBe("Nháp");
    expect((await s2.undo()).status.dirtyCount).toBe(0);
  });

  test("a new edit without answering archives the old draft", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "Nháp", "An");
    const s2 = new Session(st, () => new Date(2026, 8, 29, 11, 0, 0));
    await s2.openFolder(DIR, "vi");
    await s2.edit("Game", "Gulim", "G", "Bình");
    expect([...st.files.keys()].filter((k) => k.includes("draft")).sort()).toEqual([
      `/mu/.mumain-translator/draft-vi-20260929-110000.json`,
      `/mu/.mumain-translator/draft-vi.json`,
    ]);
  });

  test("opening another folder / locale with unsaved edits", async () => {
    const { s, st } = await opened();
    await s.edit("Game", "Event", "A", "An");
    expect(await codeOf(s.openFolder(DIR, "de"))).toBe("dirty");
    await s.openFolder(DIR, "de", null, { discard: true });
    expect(s.open!.locale).toBe("de");
    expect(await st.exists(`/mu/.mumain-translator/draft-vi.json`)).toBe(false);
  });

  test("the .mumain-translator folder is not a group", async () => {
    const { s } = await opened();
    await s.edit("Game", "Event", "A", "An");
    expect((await s.scan(DIR)).resx!.groups.map((g) => g.name)).toEqual(["Dialog", "Editor", "Game"]);
  });
});
