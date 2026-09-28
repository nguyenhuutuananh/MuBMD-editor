import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ITEM } from "../src/core";
import { createApp } from "../src/server/app";
import type { ItemsResponse, StateResponse } from "../src/shared/api";

const DATA = path.join(import.meta.dir, "../data/Item.bmd");
const assets = { html: "<html>ui</html>", js: "/*js*/", css: "/*css*/" };

function setup(pick: () => Promise<string | null> = async () => null) {
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
  test("phục vụ giao diện", async () => {
    const app = setup();
    expect(await (await app.handle(get("/"))).text()).toBe(assets.html);
    expect((await app.handle(get("/app.js"))).headers.get("content-type")).toContain("javascript");
  });

  test("chưa mở file", async () => {
    const app = setup();
    const state = (await (await app.handle(get("/api/state"))).json()) as StateResponse;
    expect(state.file).toBeNull();
    expect((await app.handle(get("/api/items"))).status).toBe(409);
  });

  test("mở file và lấy đủ 8192 slot", async () => {
    const app = setup();
    const res = await app.handle(post("/api/open", { path: DATA }));
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as StateResponse;
    expect(file).toMatchObject({ fileName: "Item.bmd", checksumValid: true, namedCount: 488 });

    const items = (await (await app.handle(get("/api/items"))).json()) as ItemsResponse;
    expect(items.items.length).toBe(MAX_ITEM);
    expect(items.items[0]).toEqual([0, "Chùy Thủy", "utf-8", 12, []]);
    expect(items.items[MAX_ITEM - 1]![2]).toBe("empty");
  });

  test("lỗi mở file rõ ràng, file đang mở vẫn giữ nguyên", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: DATA }));

    const missing = await app.handle(post("/api/open", { path: "/khong/ton/tai/Item.bmd" }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("Không tìm thấy file.");

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-")), "bad.bmd");
    fs.writeFileSync(tmp, new Uint8Array(100));
    const bad = await app.handle(post("/api/open", { path: tmp }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("688132");

    const state = (await (await app.handle(get("/api/state"))).json()) as StateResponse;
    expect(state.file?.path).toBe(path.resolve(DATA));
  });

  test("thiếu đường dẫn", async () => {
    expect((await setup().handle(post("/api/open", { path: "  " }))).status).toBe(400);
  });

  test("hộp thoại chọn file: huỷ và chọn", async () => {
    const cancelled = await setup(async () => null).handle(post("/api/pick", {}));
    expect(await cancelled.json()).toEqual({ path: null });
    const picked = await setup(async () => DATA).handle(post("/api/pick", {}));
    expect(await picked.json()).toEqual({ path: DATA });
  });
});

describe("bảo vệ localhost", () => {
  test("từ chối Host lạ (DNS rebinding)", async () => {
    expect((await setup().handle(get("/api/state", "evil.example:4817"))).status).toBe(403);
    expect((await setup().handle(get("/api/state", "127.0.0.1:4817"))).status).toBe(200);
  });

  test("POST không phải JSON bị từ chối", async () => {
    const res = await setup().handle(post("/api/open", { path: DATA }, "text/plain"));
    expect(res.status).toBe(415);
  });

  test("API không tồn tại", async () => {
    expect((await setup().handle(get("/api/khong-co"))).status).toBe(404);
  });
});

describe("API sửa + lưu", () => {
  function tempCopy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-api-"));
    const file = path.join(dir, "Item.bmd");
    fs.copyFileSync(DATA, file);
    return file;
  }
  const body = async (r: Response) => (await r.json()) as Record<string, any>;

  test("sửa -> undo -> redo -> lưu", async () => {
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
    expect(fs.existsSync(saved.backupPath)).toBe(true);
  });

  test("tên quá dài -> 422 kèm danh sách lỗi", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: tempCopy() }));
    const res = await app.handle(post("/api/edit", { slot: 0, name: "Đ".repeat(30), translator: "An" }));
    expect(res.status).toBe(422);
    const b = await body(res);
    expect(b.code).toBe("invalid-name");
    expect(b.issues[0].code).toBe("too-long");
  });

  test("mở file khác khi còn thay đổi -> 409 dirty, discard thì được", async () => {
    const file = tempCopy();
    const app = setup();
    await app.handle(post("/api/open", { path: file }));
    await app.handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }));
    const res = await app.handle(post("/api/open", { path: file }));
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("dirty");
    expect((await app.handle(post("/api/open", { path: file, discard: true }))).status).toBe(200);
  });

  test("file bị đổi bên ngoài -> 409 conflict", async () => {
    const file = tempCopy();
    const app = setup();
    await app.handle(post("/api/open", { path: file }));
    await app.handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }));
    fs.appendFileSync(file, "x");
    const res = await app.handle(post("/api/save", {}));
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("conflict");
  });

  test("slot sai -> 400", async () => {
    const app = setup();
    await app.handle(post("/api/open", { path: tempCopy() }));
    expect((await app.handle(post("/api/edit", { slot: 99999, name: "X", translator: "An" }))).status).toBe(400);
  });

  test("sửa khi chưa mở file -> 409", async () => {
    expect((await setup().handle(post("/api/edit", { slot: 0, name: "X", translator: "An" }))).status).toBe(409);
  });
});
