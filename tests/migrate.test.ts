// The first open of a workspace carries over the side data of MuResx-editor (.muresx/) and
// MuBMD-editor (Data/Items.mubmd/).
import { describe, expect, test } from "bun:test";
import { ItemData, sha1 } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import { SAMPLE_FILES } from "./fixtures/sampleLocalization";
import { sampleFiles } from "./fixtures/sampleItems";
import { ITEMS_REL, RESX_REL, sampleCheckout } from "./fixtures/sampleWorkspace";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ROOT = "/mu";
const MURESX = `${ROOT}/${RESX_REL}/.muresx`;
const MUBMD = `${ROOT}/${ITEMS_REL}.mubmd`;
const rec = (status: string, extra: object = {}) => ({ status, note: "", translator: "An", updatedAt: "2026-09-29T10:00:00.000Z", ...extra });

// What MuBMD-editor 2.x stored as namesSha1: every Vietnamese item name, [[slot, name]...].
function mubmdNamesSha1(): string {
  const data = ItemData.parse(Object.entries(sampleFiles()).map(([name, text]) => ({ name, text })));
  return sha1(enc(JSON.stringify(data.targetNames())));
}

function workspace(extra: Record<string, string>) {
  const files = sampleCheckout(ROOT);
  for (const [p, t] of Object.entries(extra)) files[p] = enc(t);
  return new MemoryStorage(files);
}
const rowOf = (s: Session, group: string, key: string) => s.rows().rows.find((r) => s.rows().groups[r[0]]!.name === group && r[1] === key);

describe("carrying over the old tools' side data", () => {
  test("MuResx-editor: records, merge bases, draft", async () => {
    const st = workspace({
      [`${MURESX}/project-vi.json`]: JSON.stringify({
        version: 1,
        locale: "vi",
        files: { "Game.vi.resx": sha1(enc(SAMPLE_FILES["Game.vi.resx"]!)) },
        records: { Game: { Event: rec("reviewed", { note: "ok", origin: "Sự kiện" }) }, Nope: { x: rec("reviewed") } },
      }),
      [`${MURESX}/draft-vi.json`]: JSON.stringify({
        version: 1,
        locale: "vi",
        savedAt: "2026-09-29T10:00:00.000Z",
        edits: [{ group: "Game", key: "Level %d", state: { value: "Cấp %d", comment: "legacy_id=11" }, record: rec("translated") }],
      }),
    });
    const s = new Session(st, () => new Date("2026-09-30T10:00:00Z"));
    const info = await s.openFolder(ROOT, "vi");
    expect(info.migrated).toEqual({ from: ["src/Localization/.muresx"], records: 1, draftEdits: 1 });
    expect(rowOf(s, "Game", "Event")![12]).toMatchObject({ status: "reviewed", note: "ok", origin: "Sự kiện" });
    expect(s.draftInfo()?.count).toBe(1);
    await s.restoreDraft();
    expect(rowOf(s, "Game", "Level %d")![3]).toBe("Cấp %d");
    // The old folder is left as it was; the next open reads the new files only.
    expect(st.files.has(`${MURESX}/project-vi.json`)).toBe(true);
    expect(JSON.parse(dec(st.files.get(`${ROOT}/.mumain-translator/project-vi.json`)!)).bases.Game).toBe(sha1(enc(SAMPLE_FILES["Game.vi.resx"]!)));
    const again = await new Session(st).openFolder(ROOT, "vi");
    expect(again.migrated).toBeNull();
  });

  test("MuResx-editor: a file changed since resets its merge bases", async () => {
    const st = workspace({
      [`${MURESX}/project-vi.json`]: JSON.stringify({
        version: 1,
        locale: "vi",
        files: { "Game.vi.resx": "an older version" },
        records: { Game: { Event: rec("translated", { origin: "Cũ" }) } },
      }),
    });
    const s = new Session(st);
    await s.openFolder(ROOT, "vi");
    expect(rowOf(s, "Game", "Event")![12]?.origin).toBe("Sự kiện"); // the text on disk now
  });

  test("MuBMD-editor 2.x: item records by slot, draft names (Vietnamese only)", async () => {
    const files = {
      [`${MUBMD}/project.json`]: JSON.stringify({
        version: 2,
        namesSha1: mubmdNamesSha1(),
        records: { "0": rec("reviewed", { origin: "Chùy Thủy" }), [String(7 * 512 + 1)]: rec("translated"), "8191": rec("reviewed") },
      }),
      [`${MUBMD}/draft.json`]: JSON.stringify({
        version: 2,
        baseSha1: "x",
        savedAt: "2026-09-29T10:00:00.000Z",
        slots: [{ slot: 1, name: "Đoản Đao", record: rec("translated") }, { slot: 2, record: rec("reviewed") }],
      }),
    };
    const s = new Session(workspace(files));
    const info = await s.openFolder(ROOT, "vi");
    expect(info.migrated).toEqual({ from: ["src/bin/Data/Items.mubmd"], records: 2, draftEdits: 2 });
    expect(rowOf(s, "Items.Sword", "0")![12]).toMatchObject({ status: "reviewed", origin: "Chùy Thủy" });
    expect(rowOf(s, "Items.Helm", "1")![12]?.status).toBe("translated");
    await s.restoreDraft();
    expect(rowOf(s, "Items.Sword", "1")![3]).toBe("Đoản Đao");
    expect(rowOf(s, "Items.Sword", "2")![11]).toBe("reviewed");

    // Another locale: MuBMD-editor only knew Vietnamese.
    const de = await new Session(workspace(files)).openFolder(ROOT, "de");
    expect(de.migrated).toBeNull();
  });

  test("MuBMD-editor: names changed since reset the merge bases", async () => {
    const s = new Session(
      workspace({
        [`${MUBMD}/project.json`]: JSON.stringify({ version: 2, namesSha1: "older", records: { "0": rec("translated", { origin: "Cũ" }) } }),
      }),
    );
    await s.openFolder(ROOT, "vi");
    expect(rowOf(s, "Items.Sword", "0")![12]?.origin).toBe("Chùy Thủy");
  });

  test("both at once; nothing to carry over = no project file written", async () => {
    const both = new Session(
      workspace({
        [`${MURESX}/project-vi.json`]: JSON.stringify({ version: 1, locale: "vi", files: {}, records: { Game: { Event: rec("reviewed") } } }),
        [`${MUBMD}/project.json`]: JSON.stringify({ version: 2, namesSha1: mubmdNamesSha1(), records: { "0": rec("reviewed") } }),
      }),
    );
    expect((await both.openFolder(ROOT, "vi")).migrated).toMatchObject({ from: ["src/Localization/.muresx", "src/bin/Data/Items.mubmd"], records: 2 });

    const st = workspace({});
    expect((await new Session(st).openFolder(ROOT, "vi")).migrated).toBeNull();
    expect(st.files.has(`${ROOT}/.mumain-translator/project-vi.json`)).toBe(false);
  });
});
