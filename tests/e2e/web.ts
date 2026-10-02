// web.ts - End-to-end test of the WEB build (build/web-static: Session in the browser, File System
// Access API, PWA) in headless Chromium. Native pickers cannot be clicked headlessly, so
// window.__MUMAIN_TR_TEST_PICK__ answers them with handles from the page's Origin Private File System
// (OPFS): the sample Localization folder is written there first; file pickers take their OPFS path
// from window.__pickQueue.
//   bun run test:e2e:web        (builds the web version first; screenshots in e2e-shots/)

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright-core";
import { ItemData } from "../../src/core";
import { SAMPLE_FILES } from "../fixtures/sampleLocalization";
import { sampleCheckout } from "../fixtures/sampleWorkspace";
import { chromiumOptions } from "./browsers";

const root = path.join(import.meta.dir, "../..");
const dist = path.join(root, "build/web-static");
const shots = path.join(root, "e2e-shots");
fs.mkdirSync(shots, { recursive: true });
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run `bun run build:web-static` first.");

// A plain static server, like GitHub Pages (the app lives under a sub-path there too).
const PORT = 4898;
const BASE = "/MuMain-translator/";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith(BASE)) return new Response("Not found", { status: 404 });
    const rel = pathname.slice(BASE.length) || "index.html";
    const file = Bun.file(path.join(dist, rel));
    return file.size ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const url = `http://localhost:${PORT}${BASE}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failures++;
}

declare global {
  interface Window {
    __MUMAIN_TR_TEST_PICK__?: (req: { mode: string }) => Promise<FileSystemHandle | null>;
    __pickQueue?: string[];
    __folder?: string;
  }
}

// Installed before the app starts: pickers return OPFS handles ("Localization" for the folder).
const PICK_HOOK = () => {
  window.__MUMAIN_TR_TEST_PICK__ = async (req) => {
    const opfs = await navigator.storage.getDirectory();
    if (req.mode === "folder") return opfs.getDirectoryHandle(window.__folder ?? "Localization");
    const rel = window.__pickQueue?.shift();
    if (!rel) return null;
    let dir = opfs;
    const parts = rel.split("/");
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    return dir.getFileHandle(parts[parts.length - 1]!, { create: req.mode === "save" });
  };
};

const opfsWrite = (p: Page, rel: string, text: string) =>
  p.evaluate(
    async ([relPath, content]) => {
      let dir = await navigator.storage.getDirectory();
      const parts = relPath!.split("/");
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1]!, { create: true })).createWritable();
      await w.write(content!);
      await w.close();
    },
    [rel, text],
  );

const opfsRead = (p: Page, rel: string) =>
  p.evaluate(async (relPath) => {
    try {
      let dir = await navigator.storage.getDirectory();
      const parts = relPath.split("/");
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(parts[parts.length - 1]!)).getFile()).text();
    } catch {
      return null;
    }
  }, rel);

const opfsList = (p: Page, rel: string) =>
  p.evaluate(async (relPath) => {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const part of relPath.split("/")) dir = await dir.getDirectoryHandle(part);
      const names: string[] = [];
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name);
      return names.sort();
    } catch {
      return [];
    }
  }, rel);

const browser = await chromium.launch(chromiumOptions());
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(PICK_HOOK);
const page = await context.newPage();
page.on("pageerror", (e) => check("no page error", false, e.message));
page.on("dialog", (d) => d.accept());
const tid = (id: string) => page.getByTestId(id);
const text = async (id: string) => (await tid(id).textContent())?.trim() ?? "";
const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent === "All saved");
const find = async (q: string) => {
  await tid("search").fill(q);
  await page.keyboard.press("Enter");
};

try {
  await page.goto(url);
  for (const [name, content] of Object.entries(SAMPLE_FILES)) await opfsWrite(page, `Localization/${name}`, content);
  await page.reload();

  check("web welcome: no path field", (await tid("path").count()) === 0 && (await tid("pick").isEnabled()));
  await tid("pick").click();
  await tid("locale-vi").click();
  await tid("open").click();
  await tid("grid").waitFor();
  check("folder opened in the browser", (await text("result-count")) === "18 rows", await text("result-count"));
  check("path shown without the handle id", (await page.locator("header").textContent())?.includes("/Localization") === true);
  check("no registration notice (the web version only sees the folder)", (await tid("unregistered").count()) === 0);

  // edit + save straight into the granted folder
  await find("Event");
  await page.keyboard.press("Enter");
  await tid("dialog").waitFor();
  await page.locator("#dialog-input").fill("Web");
  await tid("dialog-ok").click();
  await tid("inline-editor").waitFor();
  await page.keyboard.type("Sự kiện web");
  await page.keyboard.press("Enter");
  check("draft written in the folder", ((await opfsRead(page, "Localization/.mumain-translator/draft-vi.json")) ?? "").includes("Sự kiện web"));
  await page.keyboard.press("Control+s");
  await saved();
  check("saved into Game.vi.resx", ((await opfsRead(page, "Localization/Game.vi.resx")) ?? "").includes("<value>Sự kiện web</value>"));
  check("backup in .mumain-translator/backups", (await opfsList(page, "Localization/.mumain-translator/backups")).length === 1);

  // export to a TSV (save picker), change it, import it back (open picker)
  await page.evaluate(() => (window.__pickQueue = ["exchange/web.tsv"]));
  await tid("actions").click();
  await tid("action-export").click();
  await tid("export-all").click();
  await tid("export-go").click();
  await page.waitForTimeout(300);
  const tsv = (await opfsRead(page, "exchange/web.tsv")) ?? "";
  check("exported TSV", tsv.includes("Game\tEvent\tEvent\tSự kiện web"), tsv.slice(0, 120));
  await opfsWrite(page, "exchange/web.tsv", tsv.replace("Game\tLevel %d\tLevel %d\t\t", "Game\tLevel %d\tLevel %d\tCấp %d\t"));
  await page.evaluate(() => (window.__pickQueue = ["exchange/web.tsv"]));
  await tid("actions").click();
  await tid("action-import").click();
  await tid("import-apply").click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+s");
  await saved();
  check("imported and saved", ((await opfsRead(page, "Localization/Game.vi.resx")) ?? "").includes("<value>Cấp %d</value>"));
  await page.screenshot({ path: path.join(shots, "web-workspace.png") });

  // a reload: the folder is in "recently opened" (handle kept in IndexedDB)
  await page.reload();
  await tid("recent").first().waitFor();
  check("recent folder shown without the handle id", !(await text("recent")).includes("@"), await text("recent"));
  await tid("recent").first().click();
  await tid("grid").waitFor();
  check("reopened from the recent list", (await text("locale")).startsWith("vi"));

  // PWA: installed service worker, then the app opens offline
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active != null, null, { timeout: 15000 });
  await context.setOffline(true);
  await page.reload();
  await tid("pick").waitFor({ timeout: 10000 });
  check("opens offline (PWA)", true);
  await context.setOffline(false);

  // a checkout with both sources, edited in place (the OPFS folder "MU")
  const dec = new TextDecoder();
  for (const [p, b] of Object.entries(sampleCheckout("MU"))) await opfsWrite(page, p, dec.decode(b));
  await page.evaluate(() => (window.__folder = "MU"));
  await tid("pick").click(); // the offline reload above left the welcome screen open
  await tid("sources").waitFor();
  check("web: both sources found in the folder", (await text("sources")).includes("src/bin/Data/Items"), await text("sources"));
  await tid("locale-vi").click();
  await tid("open").click();
  await tid("badge-items").waitFor();
  await find("7:1");
  await page.keyboard.press("Enter");
  await tid("inline-editor").waitFor();
  await page.keyboard.type("Mũ Rồng Đỏ");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  await saved();
  const helm = (await opfsRead(page, "MU/src/bin/Data/Items/Group07_Helm.json")) ?? "";
  check("web: item name saved into the JSON file", helm !== "" && ItemData.parse([{ name: "Group07_Helm.json", text: helm }]).getName(7 * 512 + 1) === "Mũ Rồng Đỏ");
  check("web: side data at the folder root", (await opfsList(page, "MU/.mumain-translator")).includes("project-vi.json"));
  await page.screenshot({ path: path.join(shots, "web-checkout.png") });

  // AI proposals written by the MCP server into .mumain-translator/proposals/, decided in the UI
  const item = (group: string, key: string, english: string, value: string, note = "") => ({ group, key, english, base: "", value, note });
  await opfsWrite(
    page,
    "MU/.mumain-translator/proposals/vi-e2e.json",
    JSON.stringify({
      version: 1,
      locale: "vi",
      createdAt: "2026-10-01T10:00:00Z",
      by: "AI (e2e)",
      note: "",
      items: [
        item("Game", "Chaos Castle", "Chaos Castle", "Lâu Đài Hỗn Loạn", "tên sự kiện"),
        item("Game", "Connecting to the server", "Connecting to the server", "Đang kết nối tới máy chủ"),
        item("Items.Helm", "3", "Helm 3", "Mũ Ba"),
        item("Items.Helm", "5", "Helm 5", "Mũ Năm"),
      ],
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await tid("proposal-count").waitFor();
  check("proposals read on window focus", (await text("proposal-count")) === "4 AI proposals", await text("proposal-count"));
  await tid("proposal-count").click();
  await tid("search").fill("");
  await page.keyboard.press("Enter");
  check("filter: rows with a proposal", (await text("result-count")) === "4 rows", await text("result-count"));
  check("grid marks the rows", (await tid("row-proposal").count()) === 4);
  const rowWith = (s: string) => page.locator("[data-row]").filter({ hasText: s }).first();
  await rowWith("Chaos Castle").click();
  await page.screenshot({ path: path.join(shots, "web-proposal-panel.png") });
  check("detail panel shows the proposal", (await text("proposal-value")) === "Lâu Đài Hỗn Loạn" && (await text("proposal-note")).includes("tên sự kiện"));
  await tid("proposal-reject").click();
  await page.locator("#dialog-input").fill("sai tên");
  await tid("dialog-reject").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="row-proposal"]').length === 3);
  check("skipped: the translation stays", !(await rowWith("Chaos Castle").textContent())?.includes("Lâu Đài"));
  await rowWith("Helm 5").click();
  await tid("proposal-edit").click();
  await tid("inline-editor").locator("input").fill("Mũ Năm Sửa");
  await tid("inline-editor").locator("input").press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="row-proposal"]').length === 2);
  check("edited, then accepted", (await rowWith("Helm 5").textContent())?.includes("Mũ Năm Sửa") === true);
  await tid("actions").click();
  check("accept-all counts the clean ones", (await text("action-proposals-accept-clean")).includes("Accept 2"), await text("action-proposals-accept-clean"));
  await tid("action-proposals-accept-clean").click();
  await tid("dialog-accept").click();
  await tid("proposal-count").waitFor({ state: "detached" });
  await page.screenshot({ path: path.join(shots, "web-proposals.png") });
  await page.keyboard.press("Control+s");
  await saved();
  check("accepted proposals saved", ((await opfsRead(page, "MU/src/Localization/Game.vi.resx")) ?? "").includes("<value>Đang kết nối tới máy chủ</value>"));
  const helm2 = ItemData.parse([{ name: "Group07_Helm.json", text: (await opfsRead(page, "MU/src/bin/Data/Items/Group07_Helm.json")) ?? "" }]);
  check("accepted item names saved", helm2.getName(7 * 512 + 3) === "Mũ Ba" && helm2.getName(7 * 512 + 5) === "Mũ Năm Sửa");
  const decisions = JSON.parse((await opfsRead(page, "MU/.mumain-translator/proposals/decisions/vi-e2e.json")) ?? "{}");
  check(
    "decisions kept, proposal file removed",
    (await opfsList(page, "MU/.mumain-translator/proposals")).join() === "decisions" &&
      decisions.decisions?.map((d: { action: string }) => d.action).join() === "rejected,accepted,accepted,edited",
    JSON.stringify(decisions).slice(0, 200),
  );

  // a package to share: export from MU, import into another checkout (MU2, fresh), keep editing there
  await page.evaluate(() => (window.__pickQueue = ["exchange/MuMain-vi.zip"]));
  await tid("actions").click();
  await tid("action-export-package").click();
  await page.waitForFunction(() => document.body.textContent?.includes("Package exported"));
  const zipSize = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exchange");
    return (await (await dir.getFileHandle("MuMain-vi.zip")).getFile()).size;
  });
  check("package exported to the chosen file", zipSize > 1000, String(zipSize));
  for (const [p, b] of Object.entries(sampleCheckout("MU2"))) await opfsWrite(page, p, dec.decode(b));
  await page.evaluate(() => (window.__folder = "MU2"));
  await tid("open-other").click();
  await tid("pick").click();
  await tid("locale-vi").click();
  await tid("open").click();
  await tid("badge-items").waitFor();
  await page.evaluate(() => (window.__pickQueue = ["exchange/MuMain-vi.zip"]));
  await tid("actions").click();
  await tid("action-import").click();
  await tid("import-package").waitFor();
  check("import shows the package", (await text("import-package")).includes("Package from Web"), await text("import-package"));
  await tid("import-apply").click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+s");
  await saved();
  const helm3 = ItemData.parse([{ name: "Group07_Helm.json", text: (await opfsRead(page, "MU2/src/bin/Data/Items/Group07_Helm.json")) ?? "" }]);
  check("package imported into the other checkout", helm3.getName(7 * 512 + 1) === "Mũ Rồng Đỏ" && helm3.getName(7 * 512 + 5) === "Mũ Năm Sửa");
  check("UI strings came along", ((await opfsRead(page, "MU2/src/Localization/Game.vi.resx")) ?? "").includes("<value>Đang kết nối tới máy chủ</value>"));

  // Google Sheets: a ZIP of one CSV per tab
  await page.evaluate(() => (window.__pickQueue = ["exchange/sheets.zip"]));
  await tid("actions").click();
  await tid("action-export-sheets").click();
  await page.waitForFunction(() => document.body.textContent?.includes("tabs,"));
  check("exported for Google Sheets", (await opfsList(page, "exchange")).includes("sheets.zip"));

  // another language of the open folder, from the locale badge: a new one with its own name
  await tid("locale-switch").click();
  await tid("locale-new").click();
  await tid("locale-new-code").fill("th");
  check("a name suggested for a new code", (await tid("locale-name").inputValue()) === "ไทย", await tid("locale-name").inputValue());
  await tid("locale-name").fill("ภาษาไทย");
  await tid("open").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="locale"]')?.textContent?.includes("th"));
  check("switched to the new language with its name", (await text("locale")).includes("th · ภาษาไทย"), await text("locale"));
  check("the name is kept for the folder", ((await opfsRead(page, "MU2/.mumain-translator/locales.json")) ?? "").includes("ภาษาไทย"));
  await tid("locale-switch").click();
  await tid("locale-vi").click();
  await tid("open").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="locale"]')?.textContent?.startsWith("vi"));
  check("back to vi without choosing the folder again", (await text("locale")).startsWith("vi"), await text("locale"));

  // a recent folder: the locale choice instead of its last locale
  await tid("open-other").click();
  await tid("recent-locale").first().click();
  await tid("sources").waitFor();
  check("recent folder: choose another language", (await tid("locale-vi").count()) === 1);
  await page.getByRole("button", { name: /Back/ }).first().click();

  // a browser without the File System Access API (Firefox, Safari): the fallback mode
  // (tests/e2e/web-fallback.ts runs it in Firefox and WebKit)
  const other = await context.newPage();
  await other.addInitScript(() => {
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await other.goto(url);
  await other.getByTestId("fallback-hint").waitFor();
  check("no File System Access: fallback hint, folder upload", await other.getByTestId("pick").isEnabled());
} catch (e) {
  check("run", false, String(e));
  await page.screenshot({ path: path.join(shots, "web-failure.png") }).catch(() => undefined);
} finally {
  await browser.close();
  server.stop(true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall web e2e checks passed");
process.exit(failures ? 1 : 0);
