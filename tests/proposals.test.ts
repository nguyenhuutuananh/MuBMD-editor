// Proposals: translations an AI assistant / a script wrote into .mumain-translator/proposals/ for a
// person to accept or skip.
import { describe, expect, test } from "bun:test";
import { AppError, type ProposalFile, type ProposalItem, parseProposalFile, serializeProposalFile } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import type { ProposalRow } from "../src/shared/api";
import { sampleCheckout } from "./fixtures/sampleWorkspace";

const ROOT = "/mu";
const DIR = `${ROOT}/.mumain-translator/proposals`;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const item = (group: string, key: string, english: string, base: string, value: string, note = ""): ProposalItem => ({ group, key, english, base, value, note });
const file = (items: ProposalItem[], createdAt = "2026-10-01T10:00:00Z", locale = "vi"): ProposalFile => ({
  version: 1,
  locale,
  createdAt,
  by: "AI (Claude Code)",
  note: "batch",
  items,
});

async function opened(proposals: Record<string, ProposalFile | string>) {
  let t = Date.parse("2026-10-01T12:00:00Z");
  const files = sampleCheckout(ROOT);
  for (const [name, p] of Object.entries(proposals)) files[`${DIR}/${name}`] = enc(typeof p === "string" ? p : serializeProposalFile(p));
  const st = new MemoryStorage(files);
  const s = new Session(st, () => new Date((t += 1000)), "win32");
  await s.openFolder(ROOT, "vi");
  return { s, st };
}
const rowOf = (s: Session, group: string, key: string) => s.rows().rows.find((r) => s.rows().groups[r[0]]!.name === group && r[1] === key)!;
const byKey = (items: ProposalRow[], key: string) => items.find((i) => i.key === key)!;

describe("proposal file format", () => {
  test("round trip; optional fields default to empty", () => {
    const p = file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện")]);
    expect(parseProposalFile(serializeProposalFile(p))).toEqual(p);
    const bare = parseProposalFile(JSON.stringify({ version: 1, locale: "vi", items: [{ group: "Game", key: "Event", value: "x" }] }));
    expect(bare.items[0]).toEqual({ group: "Game", key: "Event", english: "", base: "", value: "x", note: "" });
  });

  test("not a proposal file", () => {
    for (const bad of ["{", "[]", '{"version":2,"locale":"vi","items":[]}', '{"version":1,"locale":"vi","items":[{"group":"Game"}]}']) {
      expect(() => parseProposalFile(bad)).toThrow(AppError);
    }
  });
});

describe("listing", () => {
  test("states against the rows as they are now", async () => {
    const { s } = await opened({
      "vi-a.json": file([
        item("Game", "Connecting to the server", "Connecting to the server", "", "Đang kết nối tới máy chủ"), // ok (untranslated)
        item("Game", "Event", "Event", "Sự kiện", "Sự kiện"), // same as now
        item("Game", "Level %d", "Level %d", "", "Cấp"), // ok, but a placeholder is missing
        item("Game", "Chaos Castle", "Chaos Castle", "Lâu Đài", "Hỗn Nguyên Lâu"), // stale: made from another translation
        item("Game", "Warning", "Old English", "", "Cảnh báo"), // stale: English changed
        item("Game", "Nope", "Nope", "", "Không"), // unknown key
        item("Items.Sword", "1", "Sword 1", "", "Kiếm||1"), // the item file cannot hold it
      ]),
      "de-a.json": file([item("Game", "Event", "Event", "", "Ereignis")], undefined, "de"), // another locale
      "broken.json": "{ nope",
    });
    const { items, broken, dir } = await s.proposals();
    expect(dir).toBe(".mumain-translator/proposals");
    expect(broken.map((b) => b.name)).toEqual(["broken.json"]);
    expect(items.map((i) => [i.key, i.state])).toEqual([
      ["Connecting to the server", "ok"],
      ["Event", "same"],
      ["Level %d", "ok"],
      ["Chaos Castle", "stale"],
      ["Warning", "stale"],
      ["Nope", "unknown"],
      ["1", "invalid"],
    ]);
    expect(byKey(items, "Level %d").issues.map((i) => i[0])).toEqual(["printf-mismatch"]);
    expect(byKey(items, "Connecting to the server")).toMatchObject({ file: "vi-a.json", index: 0, by: "AI (Claude Code)", batchNote: "batch", older: 0 });
  });

  test("a reviewed row, and an unsaved edit after the proposal was made", async () => {
    const { s } = await opened({ "vi-a.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện"), item("Game", "Chaos Castle", "Chaos Castle", "", "Hỗn Nguyên")]) });
    await s.setStatus([["Game", "Event"]], "reviewed", "An");
    await s.edit("Game", "Chaos Castle", "Lâu Đài Hỗn Nguyên", "An");
    const { items } = await s.proposals();
    expect(items.map((i) => i.state)).toEqual(["reviewed", "stale"]);
  });

  test("only the newest undecided proposal of a key is listed", async () => {
    const { s } = await opened({
      "vi-new.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện Mới")], "2026-10-01T11:00:00Z"),
      "vi-old.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện Cũ")], "2026-10-01T09:00:00Z"),
    });
    const { items } = await s.proposals();
    expect(items.map((i) => [i.file, i.value, i.older])).toEqual([["vi-new.json", "Sự Kiện Mới", 1]]);
  });
});

describe("deciding", () => {
  test("accept = one undoable edit, status translated, the proposal's note as the row's note", async () => {
    const { s, st } = await opened({ "vi-a.json": file([item("Game", "Connecting to the server", "Connecting to the server", "", "Đang kết nối", "câu ngắn")]) });
    const res = await s.decideProposals([{ file: "vi-a.json", index: 0, action: "accept" }], "An");
    expect([res.decided, res.skipped, res.proposals.items.length]).toEqual([1, 0, 0]);
    const r = rowOf(s, "Game", "Connecting to the server");
    expect([r[3], r[11], r[12]?.note, r[12]?.translator]).toEqual(["Đang kết nối", "translated", "AI: câu ngắn", "An"]);
    expect(s.status()).toMatchObject({ dirtyCount: 1, canUndo: true });
    // Every item decided: the proposal file is gone, its decision file stays.
    expect(st.files.has(`${DIR}/vi-a.json`)).toBe(false);
    const d = JSON.parse(dec(st.files.get(`${DIR}/decisions/vi-a.json`)!));
    expect(d).toMatchObject({ file: "vi-a.json", locale: "vi", proposedBy: "AI (Claude Code)" });
    expect(d.decisions).toEqual([
      expect.objectContaining({ index: 0, key: "Connecting to the server", proposed: "Đang kết nối", value: "Đang kết nối", action: "accepted", by: "An" }),
    ]);
    await s.undo();
    expect(rowOf(s, "Game", "Connecting to the server")[3]).toBeNull();
  });

  test("accept after editing; a row that has a note keeps it", async () => {
    const { s, st } = await opened({ "vi-a.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện", "viết hoa")]) });
    await s.setNote("Game", "Event", "của tôi", "An");
    await s.decideProposals([{ file: "vi-a.json", index: 0, action: "accept", value: "Sự Kiện Mới" }], "An");
    const r = rowOf(s, "Game", "Event");
    expect([r[3], r[12]?.note]).toEqual(["Sự Kiện Mới", "của tôi"]);
    const d = JSON.parse(dec(st.files.get(`${DIR}/decisions/vi-a.json`)!));
    expect(d.decisions[0]).toMatchObject({ action: "edited", proposed: "Sự Kiện", value: "Sự Kiện Mới" });
  });

  test("reject with a reason; the file stays while some items are undecided", async () => {
    const { s, st } = await opened({
      "vi-a.json": file([item("Game", "Event", "Event", "Sự kiện", "Biến Cố"), item("Game", "Chaos Castle", "Chaos Castle", "", "Hỗn Nguyên Lâu")]),
    });
    const res = await s.decideProposals([{ file: "vi-a.json", index: 0, action: "reject", reason: "sai\tnghĩa\n" }], "An");
    expect(res.changed).toEqual([]);
    expect(res.proposals.items.map((i) => i.key)).toEqual(["Chaos Castle"]);
    expect(rowOf(s, "Game", "Event")[3]).toBe("Sự kiện");
    expect(st.files.has(`${DIR}/vi-a.json`)).toBe(true);
    const d = JSON.parse(dec(st.files.get(`${DIR}/decisions/vi-a.json`)!));
    expect(d.decisions[0]).toMatchObject({ index: 0, action: "rejected", reason: "sai nghĩa", value: null });
    // A new session reads the decisions back.
    const again = new Session(st, undefined, "win32");
    await again.openFolder(ROOT, "vi");
    expect((await again.proposals()).items.map((i) => i.key)).toEqual(["Chaos Castle"]);
  });

  test("deciding the newest proposal supersedes the older ones of the key", async () => {
    const { s, st } = await opened({
      "vi-new.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện Mới")], "2026-10-01T11:00:00Z"),
      "vi-old.json": file([item("Game", "Event", "Event", "Sự kiện", "Sự Kiện Cũ")], "2026-10-01T09:00:00Z"),
    });
    // The older one is not the one listed: skipped.
    expect((await s.decideProposals([{ file: "vi-old.json", index: 0, action: "accept" }], "An")).skipped).toBe(1);
    await s.decideProposals([{ file: "vi-new.json", index: 0, action: "accept" }], "An");
    expect(rowOf(s, "Game", "Event")[3]).toBe("Sự Kiện Mới");
    expect([...st.files.keys()].filter((k) => k.startsWith(DIR)).sort()).toEqual([`${DIR}/decisions/vi-new.json`, `${DIR}/decisions/vi-old.json`]);
    expect(JSON.parse(dec(st.files.get(`${DIR}/decisions/vi-old.json`)!)).decisions[0].action).toBe("superseded");
  });

  test("several at once are one undo step; decided twice or unknown files are skipped", async () => {
    const { s } = await opened({
      "vi-a.json": file([item("Game", "Chaos Castle", "Chaos Castle", "", "Hỗn Nguyên Lâu"), item("Game", "Level %d", "Level %d", "", "Cấp %d")]),
    });
    const res = await s.decideProposals(
      [
        { file: "vi-a.json", index: 0, action: "accept" },
        { file: "vi-a.json", index: 1, action: "accept" },
        { file: "vi-a.json", index: 1, action: "reject" },
        { file: "nope.json", index: 0, action: "accept" },
      ],
      "An",
    );
    expect([res.decided, res.skipped, res.changed.length]).toEqual([2, 2, 2]);
    await s.undo();
    expect([rowOf(s, "Game", "Chaos Castle")[3], rowOf(s, "Game", "Level %d")[3]]).toEqual([null, null]);
  });

  test("a text the file cannot hold is never taken", async () => {
    const { s, st } = await opened({ "vi-a.json": file([item("Items.Sword", "1", "Sword 1", "", "Kiếm 1")]) });
    const res = await s.decideProposals([{ file: "vi-a.json", index: 0, action: "accept", value: "Kiếm||1" }], "An");
    expect([res.decided, res.skipped, res.changed.length]).toEqual([0, 1, 0]);
    expect(st.files.has(`${DIR}/decisions/vi-a.json`)).toBe(false);
  });

  test("accepted texts are saved like any edit", async () => {
    const { s, st } = await opened({ "vi-a.json": file([item("Items.Sword", "1", "Sword 1", "", "Kiếm Rồng")]) });
    await s.decideProposals([{ file: "vi-a.json", index: 0, action: "accept" }], "An");
    await s.save();
    const json = dec(st.files.get(`${ROOT}/src/bin/Data/Items/Group00_Sword.json`)!);
    expect(json).toContain('"vi": "Kiếm Rồng"');
  });
});
