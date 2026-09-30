import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ITEM } from "../src/core";
import { createApp } from "../src/server/app";
import { SAMPLE_GAME } from "./fixtures/sampleItems";
import type { ItemsResponse, StateResponse } from "../src/shared/api";

const DATA = SAMPLE_GAME;
const assets = {
  "/index.html": { type: "text/html; charset=utf-8", body: "<html>ui</html>", base64: false },
  "/assets/app-1.js": { type: "text/javascript; charset=utf-8", body: "/*js*/", base64: false },
  "/assets/logo.png": { type: "image/png", body: Buffer.from([1, 2, 3]).toString("base64"), base64: true },
};

function setup(pick: (lang: "en" | "vi", kind: string, dir?: string) => Promise<string | null> = async () => null) {
  return createApp({ assets, version: "test", pick });
}

const get = (p: string, host = "localhost:4817") => new Request(`http://${host}${p}`, { headers: { host } });
const post = (p: string, body: unknown, contentType = "application/json") =>
  new Request(`http://localhost:4817${p}`, {
    method: "POST",
    headers: { host: "localhost:4817", "content-type": contentType },
    body: JSON.stringify(body),
  });

describe("API", () => {
  test("serves the UI", async () => {
    const app = setup();
    expect(await (await app.handle(get("/"))).text()).toBe("<html>ui</html>");
    const js = await app.handle(get("/assets/app-1.js"));
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await (await app.handle(get("/assets/logo.png"))).arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await app.handle(get("/khong-co.js"))).status).toBe(404);
  });

  test("no file open yet", async () => {
    const app = setup();
    const state = (await (await app.handle(get("/api/state"))).json()) as StateResponse;
    expect(state.file).toBeNull();
    expect((await app.handle(get("/api/items"))).status).toBe(409);
  });

  test("opens a game folder and returns all 8192 slots", async () => {
    const app = setup();
    const res = await app.handle(post("/api/open", { path: DATA }));
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as StateResponse;
    expect(file).toMatchObject({ fileName: "Data/Items", layout: "game", itemCount: 488, locale: "vi" });

    const items = (await (await app.handle(get("/api/items"))).json()) as ItemsResponse;
    expect(items.items.length).toBe(MAX_ITEM);
    expect(items.items[0]).toEqual([0, "Chùy Thủy", "Sword 0", 9, []]);
    expect(items.items[MAX_ITEM - 1]![2]).toBeNull();
  });

  test("clear open errors; the currently open folder is kept", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: DATA }));

    const missing = await app.handle(post("/api/open", { path: "/khong/ton/tai" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "items-not-found", params: { folder: "/khong/ton/tai" } });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-"));
    fs.mkdirSync(path.join(tmp, "Data", "Items"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Data", "Items", "Group00_Sword.json"), "{ nope");
    const bad = await app.handle(post("/api/open", { path: tmp }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "item-json", params: { file: "Group00_Sword.json" } });

    const state = (await (await app.handle(get("/api/state"))).json()) as StateResponse;
    expect(state.file?.root).toBe(path.resolve(DATA));
  });

  test("missing path", async () => {
    const res = await setup().handle(post("/api/open", { path: "  " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "missing-path" });
  });

  test("file dialog receives the UI language", async () => {
    let got = "";
    const app = setup(async (lang) => {
      got = lang;
      return null;
    });
    await app.handle(post("/api/pick", { lang: "vi" }));
    expect(got).toBe("vi");
    await app.handle(post("/api/pick", { lang: "xx" }));
    expect(got).toBe("en");
  });

  test("dialog kinds: the game folder by default; dialogs start at the open game folder", async () => {
    const calls: [string, string | undefined][] = [];
    const app = setup(async (_lang, kind, dir) => {
      calls.push([kind, dir]);
      return null;
    });
    await app.handle(post("/api/pick", { kind: "bmd" }));
    await app.handle(post("/api/open", { path: DATA }));
    await app.handle(post("/api/pick", { kind: "compare" }));
    await app.handle(post("/api/pick", { kind: "tsv" }));
    expect(calls).toEqual([
      ["game", undefined],
      ["compare", path.dirname(path.resolve(DATA))],
      ["tsv", path.resolve(DATA)],
    ]);
  });

  test("file dialog: cancel and pick", async () => {
    const cancelled = await setup(async () => null).handle(post("/api/pick", {}));
    expect(await cancelled.json()).toEqual({ path: null });
    const picked = await setup(async () => DATA).handle(post("/api/pick", {}));
    expect(await picked.json()).toEqual({ path: DATA });
  });
});

describe("localhost protection", () => {
  test("rejects foreign Host headers (DNS rebinding)", async () => {
    const evil = await setup().handle(get("/api/state", "evil.example:4817"));
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ code: "not-local" });
    expect((await setup().handle(get("/api/state", "127.0.0.1:4817"))).status).toBe(200);
  });

  test("non-JSON POST is rejected", async () => {
    const res = await setup().handle(post("/api/open", { path: DATA }, "text/plain"));
    expect(res.status).toBe(415);
  });

  test("unknown API", async () => {
    expect((await setup().handle(get("/api/khong-co"))).status).toBe(404);
  });
});

describe("edit + save API", () => {
  function tempCopy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-api-"));
    fs.cpSync(DATA, dir, { recursive: true });
    return dir;
  }
  const body = async (r: Response) => (await r.json()) as Record<string, any>;

  test("edit -> undo -> redo -> save", async () => {
    const file = tempCopy();
    const app = setup();
    await app.handle(post("/api/open", { path: file }));

    const edited = await body(await app.handle(post("/api/edit", { slot: 0, name: "Chùy Mới", translator: "An" })));
    expect(edited.changed[0].item[1]).toBe("Chùy Mới");
    expect(edited.changed[0].edit).toMatchObject({ originalText: "Chùy Thủy", translator: "An" });

    expect((await body(await app.handle(post("/api/undo", {})))).status.dirtyCount).toBe(0);
    expect((await body(await app.handle(post("/api/redo", {})))).status.dirtyCount).toBe(1);

    const items = await body(await app.handle(get("/api/items")));
    expect(items.edits).toHaveLength(1);

    const saved = await body(await app.handle(post("/api/save", {})));
    expect(saved.savedCount).toBe(1);
    expect(saved.status.dirtyCount).toBe(0);
    expect(saved.written.map((p: string) => path.basename(p))).toEqual(["Group00_Sword.json"]);
    expect(fs.readdirSync(saved.backupDir)).toEqual([expect.stringMatching(/^Group00_Sword-.*\.json$/)]);
  });

  test("over-long name -> 422 with issue list", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: tempCopy() }));
    const res = await app.handle(post("/api/edit", { slot: 0, name: "Đ".repeat(50), translator: "An" }));
    expect(res.status).toBe(422);
    const b = await body(res);
    expect(b.code).toBe("invalid-name");
    expect(b.params).toEqual({ slot: 0 });
    expect(b.issues[0]).toMatchObject({ code: "too-long", params: { chars: 50, max: 49 } });
  });

  test("opening another file with unsaved changes -> 409 dirty, allowed with discard", async () => {
    const file = tempCopy();
    const app = setup();
    await app.handle(post("/api/open", { path: file }));
    await app.handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }));
    const res = await app.handle(post("/api/open", { path: file }));
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: "dirty", params: { count: 1 } });
    expect((await app.handle(post("/api/open", { path: file, discard: true }))).status).toBe(200);
  });

  test("file changed externally -> 409 conflict", async () => {
    const file = tempCopy();
    const app = setup();
    await app.handle(post("/api/open", { path: file }));
    await app.handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }));
    fs.appendFileSync(path.join(file, "Data", "Items", "Group00_Sword.json"), " ");
    const res = await app.handle(post("/api/save", {}));
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("conflict");
  });

  test("slot sai -> 400", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: tempCopy() }));
    const res = await app.handle(post("/api/edit", { slot: 99999, name: "X", translator: "An" }));
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ code: "no-item", params: { slot: 99999 } });
    const none = await app.handle(post("/api/edit", { slot: 8191, name: "X", translator: "An" }));
    expect(await body(none)).toMatchObject({ code: "no-item", params: { slot: 8191 } });
  });

  test("editing with no file open -> 409", async () => {
    const res = await setup().handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no-file" });
  });
});

describe("glossary API", () => {
  test("load the legacy CSV, save as TSV, load again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-gloss-"));
    const csv = path.join(dir, "g.csv");
    fs.writeFileSync(csv, "Loại,Thuật ngữ / Mẫu,Ghi chú\nĐã chốt dịch,Defense -> Phòng Thủ,PT\n");
    const app = setup();
    const loaded = (await (await app.handle(post("/api/glossary/load", { path: csv }))).json()) as Record<string, any>;
    expect(loaded).toMatchObject({ format: "legacy-csv", entries: [{ term: "Defense", translation: "Phòng Thủ", note: "PT" }] });

    const tsv = path.join(dir, "g.tsv");
    const entries = [...loaded.entries, { term: "Helm", translation: "Mũ", note: "", category: "Item" }, { term: " ", translation: "x" }];
    const saved = (await (await app.handle(post("/api/glossary/save", { path: tsv, entries }))).json()) as Record<string, any>;
    expect(saved.entries).toHaveLength(2);
    const again = (await (await app.handle(post("/api/glossary/load", { path: tsv }))).json()) as Record<string, any>;
    expect(again.format).toBe("tsv");
    expect(again.entries.map((e: { term: string }) => e.term)).toEqual(["Defense", "Helm"]);
  });

  test("missing file -> file-not-found", async () => {
    const res = await setup().handle(post("/api/glossary/load", { path: "/khong/co.tsv" }));
    expect(await res.json()).toMatchObject({ code: "file-not-found" });
  });
});
