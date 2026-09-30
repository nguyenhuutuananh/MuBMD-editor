import { describe, expect, test } from "bun:test";
import { AppError, parseTranslationTsv } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import type { KeyRef, RowTuple } from "../src/shared/api";
import { SAMPLE_FILES, sampleBytes } from "./fixtures/sampleLocalization";

const DIR = "/mu/src/Localization";
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

function storage() {
  return new MemoryStorage(Object.fromEntries(Object.entries(sampleBytes()).map(([n, b]) => [`${DIR}/${n}`, b])));
}
async function openOn(st: MemoryStorage, hour = 10) {
  let t = 0;
  const s = new Session(st, () => new Date(Date.UTC(2026, 8, 29, hour, 0, t++)));
  await s.openFolder(DIR, "vi");
  return s;
}
const row = (s: Session, key: string) => s.rows().rows.find((r) => r[1] === key)!;
const status = (r: RowTuple) => r[11];
const record = (r: RowTuple) => r[12];
const project = (st: MemoryStorage) => JSON.parse(dec(st.files.get(`/mu/.mumain-translator/project-vi.json`)!));
const allKeys = (s: Session): KeyRef[] => s.rows().rows.map((r) => [s.rows().groups[r[0]]!.name, r[1]]);

describe("status and notes", () => {
  test("derived from the text until set", async () => {
    const s = await openOn(storage());
    expect(status(row(s, "Event"))).toBe("translated");
    expect(status(row(s, "Gulim"))).toBe("untranslated"); // identical to English
    expect(status(row(s, "Level %d"))).toBe("untranslated"); // missing
    expect(record(row(s, "Event"))).toBeNull();
  });

  test("set, noted, saved in project-vi.json (not in the .resx), undoable", async () => {
    const st = storage();
    const s = await openOn(st);
    const res = await s.setStatus([["Game", "Event"], ["Game", "Gulim"], ["Game", "Nope"]], "reviewed", "An");
    expect(res.changed.map((r) => [r[1], status(r)])).toEqual([
      ["Event", "reviewed"],
      ["Gulim", "reviewed"],
    ]);
    await s.setNote("Game", "Event", "  ok\tđã   xem\n", "Bình");
    expect(record(row(s, "Event"))).toMatchObject({ status: "reviewed", note: "ok đã   xem", translator: "Bình", origin: "Sự kiện" });
    expect(s.status().dirtyCount).toBe(2);
    await s.save();
    const p = project(st);
    expect(p.records.Game.Event).toMatchObject({ status: "reviewed", note: "ok đã   xem" });
    expect(Object.keys(p.bases).sort()).toEqual(["Editor", "Game"]);
    expect(dec(st.files.get(`${DIR}/Game.vi.resx`)!)).toBe(SAMPLE_FILES["Game.vi.resx"]!); // text untouched

    const s2 = await openOn(st, 11);
    expect(status(row(s2, "Event"))).toBe("reviewed");
    await s2.undo(); // nothing to undo in a new session
    expect(s2.status().canUndo).toBe(false);
  });

  test("editing the text sets translated (a reviewed line needs a new review); back to saved = clean", async () => {
    const s = await openOn(storage());
    await s.setStatus([["Game", "Event"]], "reviewed", "An");
    await s.save();
    await s.edit("Game", "Event", "Biến cố", "Bình");
    expect(status(row(s, "Event"))).toBe("translated");
    await s.edit("Game", "Event", "Sự kiện", "Bình");
    expect([status(row(s, "Event")), s.status().dirtyCount]).toEqual(["reviewed", 0]);
    await s.edit("Game", "Event", null, "Bình");
    expect(status(row(s, "Event"))).toBe("untranslated");
  });

  test("the draft carries records", async () => {
    const st = storage();
    const s = await openOn(st);
    await s.setNote("Game", "Event", "nháp", "An");
    const s2 = await openOn(st, 11);
    expect(s2.rows().draft).toMatchObject({ count: 1, translators: ["An"] });
    await s2.restoreDraft();
    expect(record(row(s2, "Event"))).toMatchObject({ note: "nháp", translator: "An" });
  });
});

describe("TSV exchange between two translators", () => {
  test("export -> other copy edits -> import back: 3-way merge", async () => {
    // Coordinator and translator start from the same files.
    const coord = storage();
    const trans = storage();
    const c = await openOn(coord);
    const t = await openOn(trans);

    // The translator translates two keys and changes one; the coordinator changes Event too.
    await t.edit("Game", "Level %d", "Cấp %d", "Bình");
    await t.edit("Game", "Chaos Castle", "Lâu Đài Hỗn Loạn", "Bình");
    await t.edit("Game", "Event", "Biến cố", "Bình");
    await t.setNote("Game", "Chaos Castle", "tên bản đồ", "Bình");
    await t.save();
    await c.edit("Game", "Event", "Sự kiện (mới)", "An");

    await t.exportTsv("/tmp/binh.tsv", allKeys(t));
    const tsv = dec(trans.files.get("/tmp/binh.tsv")!);
    const binh = parseTranslationTsv(tsv).rows.find((r) => r.key === "Chaos Castle")!;
    expect([binh.value, binh.base, binh.translator, binh.note]).toEqual(["Lâu Đài Hỗn Loạn", "", "Bình", "tên bản đồ"]);

    coord.files.set("/tmp/binh.tsv", enc(tsv));
    const preview = await c.previewImport("/tmp/binh.tsv");
    expect(preview.hasBase).toBe(true);
    expect(preview.items.map((i) => [i.key, i.kind, i.take])).toEqual([
      ["Event", "conflict", false],
      ["Level %d", "apply", true],
      ["Chaos Castle", "apply", true],
    ]);
    const take = preview.items.filter((i) => i.take).map((i): KeyRef => [i.group, i.key]);
    const res = await c.applyImport("/tmp/binh.tsv", preview.token, take, "An");
    expect(res.changed.map((r) => [r[1], r[3], status(r)])).toEqual([
      ["Level %d", "Cấp %d", "translated"],
      ["Chaos Castle", "Lâu Đài Hỗn Loạn", "translated"],
    ]);
    expect(record(row(c, "Chaos Castle"))).toMatchObject({ translator: "Bình", note: "tên bản đồ" });
    expect(row(c, "Event")[3]).toBe("Sự kiện (mới)"); // ours kept
    // one undo step for the whole import
    await c.undo();
    expect(row(c, "Level %d")[3]).toBeNull();
    await c.redo();

    // the file changed since the preview
    coord.files.set("/tmp/binh.tsv", enc(tsv + "Game\tGulim\tG\n"));
    try {
      await c.applyImport("/tmp/binh.tsv", preview.token, take, "An");
      throw new Error("no error");
    } catch (e) {
      expect((e as AppError).code).toBe("import-changed");
    }
  });

  test("a file replaced from outside (git pull) resets the merge bases", async () => {
    const st = storage();
    const s = await openOn(st);
    await s.edit("Game", "Event", "Biến cố", "An");
    await s.save();
    expect(project(st).records.Game.Event.origin).toBe("Sự kiện");

    // a new master copy arrives: Event is now "Sự kiện chính"
    const next = dec(st.files.get(`${DIR}/Game.vi.resx`)!).replace("Biến cố", "Sự kiện chính");
    st.files.set(`${DIR}/Game.vi.resx`, enc(next));
    const s2 = await openOn(st, 11);
    expect(record(row(s2, "Event"))!.origin).toBe("Sự kiện chính");
    expect(project(st).records.Game.Event.origin).toBe("Sự kiện chính"); // written once
  });

  test("another copy of the tool wrote the project file: conflict on save", async () => {
    const st = storage();
    const a = await openOn(st);
    const b = await openOn(st, 11);
    await b.setNote("Game", "Event", "b", "B");
    await b.save();
    await a.setNote("Game", "Gulim", "a", "A");
    try {
      await a.save();
      throw new Error("no error");
    } catch (e) {
      expect([(e as AppError).code, (e as AppError).params.files]).toEqual(["conflict", ".mumain-translator/project-vi.json"]);
    }
    await a.rebase();
    await a.save();
    expect(Object.keys(project(st).records.Game).sort()).toEqual(["Event", "Gulim"]);
  });
});
