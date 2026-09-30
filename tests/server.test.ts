import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/server/app";
import type {
  ErrorResponse,
  WorkspaceListing,
  GlossaryInfo,
  ImportPreview,
  DecideResponse,
  MutationResponse,
  ProposalsResponse,
  RebaseResponse,
  RowsResponse,
  SaveResponse,
  StateResponse,
} from "../src/shared/api";
import { writeSampleLocalization } from "./fixtures/sampleLocalization";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-"));
writeSampleLocalization(DIR);

const assets = {
  "/index.html": { type: "text/html; charset=utf-8", body: "<html>ui</html>", base64: false },
  "/assets/app-1.js": { type: "text/javascript; charset=utf-8", body: "/*js*/", base64: false },
  "/assets/logo.png": { type: "image/png", body: Buffer.from([1, 2, 3]).toString("base64"), base64: true },
};

const setup = (pick: () => Promise<string | null> = async () => null) => createApp({ assets, version: "test", pick });

const get = (p: string, host = "localhost:4827") => new Request(`http://${host}${p}`, { headers: { host } });
const post = (p: string, body: unknown, contentType = "application/json") =>
  new Request(`http://localhost:4827${p}`, {
    method: "POST",
    headers: { host: "localhost:4827", "content-type": contentType },
    body: JSON.stringify(body),
  });
const body = async <T>(r: Response) => (await r.json()) as T;

describe("API", () => {
  test("serves the UI", async () => {
    const app = setup();
    expect(await (await app.handle(get("/"))).text()).toBe("<html>ui</html>");
    const js = await app.handle(get("/assets/app-1.js"));
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await (await app.handle(get("/assets/logo.png"))).arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await app.handle(get("/nope.js"))).status).toBe(404);
  });

  test("nothing open yet", async () => {
    const app = setup();
    expect((await body<StateResponse>(await app.handle(get("/api/state")))).open).toBeNull();
    const rows = await app.handle(get("/api/rows"));
    expect(rows.status).toBe(409);
    expect((await body<ErrorResponse>(rows)).code).toBe("no-folder");
  });

  test("scan, open, rows, reference", async () => {
    const app = setup();
    const listing = await body<WorkspaceListing>(await app.handle(post("/api/scan", { path: DIR })));
    expect(listing.locales.map((l) => l.code)).toEqual(["en", "de", "vi"]);

    const opened = await app.handle(post("/api/open", { path: DIR, locale: "vi", reference: "de" }));
    expect(opened.status).toBe(200);
    expect((await body<StateResponse>(opened)).open).toMatchObject({ locale: "vi", reference: "de" });

    const rows = await body<RowsResponse>(await app.handle(get("/api/rows")));
    expect(rows.groups.map((g) => g.name)).toEqual(["Dialog", "Editor", "Game"]);
    expect(rows.rows.find((r) => r[1] === "Event")!.slice(0, 5)).toEqual([2, "Event", "Event", "Sự kiện", "Ereignis"]);

    const ref = await body<StateResponse>(await app.handle(post("/api/reference", { locale: null })));
    expect(ref.open!.reference).toBeNull();
  });

  test("the folder dialog", async () => {
    const app = setup(async () => DIR);
    expect(await body<{ path: string }>(await app.handle(post("/api/pick", { lang: "vi" })))).toEqual({ path: DIR });
  });

  test("coded errors", async () => {
    const app = setup();
    const cases: Array<[Request, number, string]> = [
      [post("/api/scan", {}), 400, "missing-path"],
      [post("/api/scan", { path: path.join(DIR, "nope") }), 404, "file-not-found"],
      [post("/api/open", { path: DIR, locale: "ja" }), 400, "locale-not-found"],
      [post("/api/reference", { locale: "de" }), 409, "no-folder"],
      [post("/api/scan", { path: DIR }, "text/plain"), 415, "unsupported-media"],
      [post("/api/nope", {}), 404, "unknown-api"],
      [get("/api/state", "evil.example:4827"), 403, "not-local"],
    ];
    for (const [req, status, code] of cases) {
      const res = await app.handle(req);
      expect([req.url, res.status, (await body<ErrorResponse>(res)).code]).toEqual([req.url, status, code]);
    }
  });

  test("openPath at startup", async () => {
    const app = setup();
    expect((await app.openPath(DIR, "vi")).status).toBe(200);
    expect(app.session.open!.locale).toBe("vi");
  });
});

describe("editing API", () => {
  test("edit, keep, undo, save, conflict", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-edit-"));
    writeSampleLocalization(dir);
    const app = setup();
    await app.handle(post("/api/open", { path: dir, locale: "vi" }));

    const edit = await body<MutationResponse>(await app.handle(post("/api/edit", { group: "Game", key: "Event", value: "Sự kiện mới", translator: "An" })));
    expect(edit.changed[0]!.slice(1, 4)).toEqual(["Event", "Event", "Sự kiện mới"]);
    expect(edit.status.dirtyCount).toBe(1);
    const keep = await body<MutationResponse>(await app.handle(post("/api/keep", { group: "Game", key: "Chaos Castle", keep: true, translator: "An" })));
    expect(keep.changed[0]![3]).toBe("Chaos Castle");
    expect((await body<MutationResponse>(await app.handle(post("/api/undo", {})))).status.dirtyCount).toBe(1);

    const rows = await body<RowsResponse>(await app.handle(get("/api/rows")));
    expect(rows.status).toMatchObject({ dirtyCount: 1, canRedo: true });

    // someone changed the file: 409 conflict, then rebase + save
    const f = path.join(dir, "Game.vi.resx");
    fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replace("Quái vật", "Quái"));
    const conflict = await app.handle(post("/api/save", {}));
    expect([conflict.status, (await body<ErrorResponse>(conflict)).code]).toEqual([409, "conflict"]);
    expect(await body<RebaseResponse>(await app.handle(post("/api/rebase", {})))).toEqual({ changedFiles: ["Game.vi.resx"], conflicts: [] });
    const saved = await body<SaveResponse>(await app.handle(post("/api/save", {})));
    expect([saved.files, saved.status.dirtyCount]).toEqual([["Game.vi.resx"], 0]);
    expect(fs.readFileSync(f, "utf-8")).toContain("<value>Sự kiện mới</value>");
    expect(fs.readFileSync(f, "utf-8")).toContain("<value>Quái</value>");
    expect(fs.existsSync(path.join(dir, ".mumain-translator", "changes.tsv"))).toBe(true);

    // bad requests
    const bad = await app.handle(post("/api/edit", { group: "Game", key: "Nope", value: "x" }));
    expect([bad.status, (await body<ErrorResponse>(bad)).code]).toEqual([422, "not-editable"]);
    expect((await app.handle(post("/api/edit", { group: "Game", key: "Event", value: 3 }))).status).toBe(400);

    // unsaved edits block opening another locale
    await app.handle(post("/api/edit", { group: "Game", key: "Event", value: "X", translator: "An" }));
    const dirty = await app.handle(post("/api/open", { path: dir, locale: "de" }));
    expect([dirty.status, (await body<ErrorResponse>(dirty)).params]).toEqual([409, { count: 1 }]);
    expect((await app.handle(post("/api/open", { path: dir, locale: "de", discard: true }))).status).toBe(200);
  });
});

describe("team API", () => {
  test("status, note, export, import, glossary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-team-"));
    writeSampleLocalization(dir);
    const out = path.join(dir, "..", `${path.basename(dir)}-export.tsv`);
    const gloss = path.join(dir, "..", `${path.basename(dir)}-glossary.tsv`);
    const app = createApp({ assets, version: "test", pick: async () => out, pickSave: async (p) => p });
    await app.handle(post("/api/open", { path: dir, locale: "vi" }));

    const st = await body<MutationResponse>(await app.handle(post("/api/status", { keys: [["Game", "Event"]], status: "reviewed", translator: "An" })));
    expect(st.changed[0]![11]).toBe("reviewed");
    expect((await app.handle(post("/api/status", { keys: [], status: "done" }))).status).toBe(400);
    const note = await body<MutationResponse>(await app.handle(post("/api/note", { group: "Game", key: "Event", note: "ok", translator: "An" })));
    expect(note.changed[0]![12]).toMatchObject({ note: "ok" });

    // the save dialog starts next to the Localization folder, never inside it
    const pick = await body<{ path: string }>(await app.handle(post("/api/pick-save", { kind: "tsv", defaultName: "a/b.tsv" })));
    expect(pick.path).toBe(path.join(path.dirname(dir), "a_b.tsv"));

    const exp = await body<{ count: number }>(await app.handle(post("/api/export", { path: out, keys: [["Game", "Event"], ["Game", "Level %d"]] })));
    expect(exp.count).toBe(2);
    fs.writeFileSync(out, fs.readFileSync(out, "utf-8").replace(/Level %d\tLevel %d\t\t/, "Level %d\tLevel %d\tCấp %d\t"));
    const preview = await body<ImportPreview>(await app.handle(post("/api/import/preview", { path: out })));
    expect(preview.items.map((i) => [i.key, i.kind])).toEqual([["Level %d", "apply"]]);
    const applied = await body<MutationResponse>(
      await app.handle(post("/api/import/apply", { path: out, token: preview.token, take: [["Game", "Level %d"]], translator: "An" })),
    );
    expect(applied.changed[0]![3]).toBe("Cấp %d");
    const stale = await app.handle(post("/api/import/apply", { path: out, token: "x", take: [], translator: "An" }));
    expect([stale.status, (await body<ErrorResponse>(stale)).code]).toEqual([409, "import-changed"]);

    const saved = await body<GlossaryInfo>(
      await app.handle(post("/api/glossary/save", { path: gloss, entries: [{ term: "Helm", translation: "Mũ", note: "", category: "Item" }, { term: "Dragon", translation: "Rồng", note: "", category: "", source: "Mu VN", status: "suggested" }, { term: " " }] })),
    );
    expect(saved.entries.length).toBe(2); // the blank term is dropped
    const loaded = (await body<GlossaryInfo>(await app.handle(post("/api/glossary/load", { path: gloss })))).entries;
    expect(loaded[0]).toMatchObject({ term: "Helm", translation: "Mũ" });
    expect(loaded[0]!.status ?? "confirmed").toBe("confirmed");
    expect(loaded[1]).toMatchObject({ term: "Dragon", source: "Mu VN", status: "suggested" });
  });
});

describe("proposals API", () => {
  test("list and decide", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-proposals-"));
    writeSampleLocalization(dir);
    fs.mkdirSync(path.join(dir, ".mumain-translator", "proposals"), { recursive: true });
    const items = [{ group: "Game", key: "Chaos Castle", english: "Chaos Castle", base: "", value: "Hỗn Nguyên Lâu", note: "" }];
    fs.writeFileSync(path.join(dir, ".mumain-translator", "proposals", "vi-1.json"), JSON.stringify({ version: 1, locale: "vi", createdAt: "", by: "AI", note: "", items }));
    const app = setup();
    await app.handle(post("/api/open", { path: dir, locale: "vi" }));
    const list = await body<ProposalsResponse>(await app.handle(get("/api/proposals")));
    expect(list.items.map((i) => [i.key, i.state])).toEqual([["Chaos Castle", "ok"]]);
    const res = await body<DecideResponse>(await app.handle(post("/api/proposals/decide", { decisions: [{ file: "vi-1.json", index: 0, action: "accept" }], translator: "An" })));
    expect([res.decided, res.changed[0]?.[3], res.proposals.items.length]).toEqual([1, "Hỗn Nguyên Lâu", 0]);
    expect(fs.existsSync(path.join(dir, ".mumain-translator", "proposals", "decisions", "vi-1.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
