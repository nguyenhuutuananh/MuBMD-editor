// web-fallback.ts - End-to-end test of the web build WITHOUT the File System Access API: the folder
// is uploaded into the browser (IndexedDB) and saving downloads the result. Runs on:
//   - Playwright's Chromium with "?fallback" (forces the mode)
//   - Playwright's Firefox and WebKit (Safari's engine), where the mode is detected by itself
//     (each skipped if not installed: `bunx playwright-core install firefox webkit`)
//   bun run test:e2e:fallback       (builds the web version first; screenshots in e2e-shots/)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type Page, chromium, firefox, webkit } from "playwright-core";
import { ItemData } from "../../src/core";
import { writeSampleCheckout } from "../fixtures/sampleWorkspace";
import { chromiumOptions, installed } from "./browsers";

const root = path.join(import.meta.dir, "../..");
const dist = path.join(root, "build/web-static");
const shots = path.join(root, "e2e-shots");
fs.mkdirSync(shots, { recursive: true });
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run `bun run build:web-static` first.");

// A checkout on disk to upload, plus files that must not be read.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-fallback-"));
const CHECKOUT = writeSampleCheckout(path.join(work, "MU"));
fs.mkdirSync(path.join(CHECKOUT, ".git", "objects"), { recursive: true });
fs.writeFileSync(path.join(CHECKOUT, ".git", "objects", "Game.en.resx"), "not xml");
fs.mkdirSync(path.join(CHECKOUT, "src", "bin", "Data", "Items", "Models"), { recursive: true });
fs.writeFileSync(path.join(CHECKOUT, "src", "bin", "Data", "Items", "Models", "Group00_Sword.json"), "{ not an item file");
fs.writeFileSync(path.join(CHECKOUT, "README.md"), "# MuMain");

const PORT = 4897;
const BASE = "/MuMain-translator/";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith(BASE)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path.join(dist, pathname.slice(BASE.length) || "index.html"));
    return file.size ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const url = `http://localhost:${PORT}${BASE}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failures++;
}

const dec = new TextDecoder();

// Run `action`; the downloaded file (name + bytes), or null if nothing was downloaded.
async function downloadOf(p: Page, action: () => Promise<unknown>, timeout = 8000) {
  const dl = p.waitForEvent("download", { timeout }).catch(() => null);
  await action();
  const d = await dl;
  if (!d) return null;
  const file = path.join(work, `dl-${Date.now()}-${d.suggestedFilename()}`);
  await d.saveAs(file);
  return { name: d.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(file)) };
}

async function scenario(label: string, browser: Browser, pageUrl: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on("pageerror", (e) => check(`${label}: no page error`, false, e.message));
  p.on("dialog", (d) => d.accept().catch(() => undefined));
  const tid = (id: string) => p.getByTestId(id);
  const text = async (id: string) => (await tid(id).textContent())?.trim() ?? "";
  const mod = label.startsWith("Chromium") || process.platform !== "darwin" ? "Control" : "Meta";
  const find = async (q: string) => {
    await tid("search").fill(q);
    await p.keyboard.press("Enter");
  };
  const edit = async (q: string, value: string) => {
    await find(q);
    await p.keyboard.press("Enter");
    const dialog = await tid("dialog").isVisible().catch(() => false);
    if (dialog) {
      await p.locator("#dialog-input").fill("Fallback");
      await tid("dialog-ok").click();
    }
    await tid("inline-editor").waitFor();
    await p.locator("[data-testid=inline-editor] input").fill(value);
    await p.keyboard.press("Enter");
    await p.keyboard.press("Escape");
  };
  const dirty = (n: number) => p.waitForFunction((want) => document.querySelector('[data-testid="dirty-status"]')?.textContent?.includes(want), `${n} unsaved`);

  // 1. welcome: fallback hint, upload button
  await p.goto(pageUrl);
  await tid("fallback-hint").waitFor();
  check(`${label}: fallback hint + upload button`, (await text("pick")).includes("upload"), await text("pick"));

  // 2. upload the checkout: both sources found in the browser copy
  const chooser = p.waitForEvent("filechooser");
  await tid("pick").click();
  await (await chooser).setFiles(CHECKOUT);
  await tid("sources").waitFor();
  check(`${label}: both sources in the upload`, (await text("sources")).includes("src/Localization") && (await text("sources")).includes("src/bin/Data/Items"));
  await tid("locale-vi").click();
  await tid("open").click();
  await tid("badge-items").waitFor();
  check(`${label}: browser copy`, await tid("browser-copy").isVisible());

  // 3. one changed file: downloaded as it is
  await edit("7:1", "Mũ Rồng Đỏ");
  await dirty(1);
  await p.focus("[data-testid=grid]");
  const one = await downloadOf(p, () => p.keyboard.press(`${mod}+s`));
  const helm = one ? ItemData.parse([{ name: one.name, text: dec.decode(one.bytes) }]) : null;
  check(`${label}: one file saved = that file downloaded`, one?.name === "Group07_Helm.json" && helm?.getName(7 * 512 + 1) === "Mũ Rồng Đỏ", one?.name);

  // 4. several files (a string and an item name): one zip laid out like the folder
  await edit("Event", "Sự kiện mới");
  await edit("0:1", "Đoản Đao");
  await dirty(2);
  await p.focus("[data-testid=grid]");
  const zipped = await downloadOf(p, () => p.keyboard.press(`${mod}+s`));
  const zipText = zipped ? dec.decode(zipped.bytes) : "";
  check(
    `${label}: several files = a zip with their paths`,
    zipped?.name === "MU-vi.zip" &&
      zipText.startsWith("PK") &&
      zipText.includes("src/Localization/Game.vi.resx") &&
      zipText.includes("src/bin/Data/Items/Group00_Sword.json") &&
      zipText.includes("Đoản Đao"),
    zipped?.name,
  );
  await p.screenshot({ path: path.join(shots, `fallback-${label.split(" ")[0]!.toLowerCase()}.png`) });

  // 5. a status-only change downloads nothing (no file is rewritten)
  await find("Event");
  await p.keyboard.press("Alt+Digit3");
  await dirty(1);
  const none = await downloadOf(p, () => p.keyboard.press(`${mod}+s`), 2500);
  check(`${label}: status-only save stays in the browser`, none === null);

  // 6. export: the TSV is downloaded
  await tid("search").fill("");
  await p.keyboard.press("Enter");
  await tid("actions").click();
  await tid("action-export").click();
  await tid("export-all").click();
  const tsv = await downloadOf(p, () => tid("export-go").click());
  const tsvText = tsv ? dec.decode(tsv.bytes) : "";
  check(`${label}: export downloads a TSV with both sources`, !!tsv && tsvText.includes("Game\tEvent") && tsvText.includes("Items.Helm\t1\tHelm 1\tMũ Rồng Đỏ"), tsv?.name);

  // 7. import an uploaded TSV (a MuBMD-editor file)
  const importChooser = p.waitForEvent("filechooser");
  await tid("actions").click();
  await tid("action-import").click();
  await (await importChooser).setFiles({ name: "old.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("ItemType\tItemIndex\tName\n0\t3\tKiếm Nhật\n") });
  await tid("import-dialog").waitFor();
  await tid("import-apply").click();
  await dirty(1);
  check(`${label}: import from an uploaded TSV`, true);

  // 8. a reload: the browser copy and its draft come back from "recently opened"
  await p.reload();
  await tid("recent").first().click();
  await tid("dialog").waitFor();
  await tid("dialog-restore").click();
  await dirty(1);
  await find("0:3");
  check(`${label}: reopened from the browser copy with its draft`, (await text("detail-value")) === "Kiếm Nhật", await text("detail-value"));
  await ctx.close();
}

const browsers: Browser[] = [];
try {
  const c = await chromium.launch(chromiumOptions());
  browsers.push(c);
  await scenario("Chromium ?fallback", c, `${url}?fallback`);
  for (const [type, name] of [
    [firefox, "Firefox"],
    [webkit, "WebKit (Safari)"],
  ] as const) {
    const exe = installed(type);
    if (!exe) {
      console.log(`(${name} not installed - skipped: bunx playwright-core install ${type.name()})`);
      continue;
    }
    const b = await type.launch({ executablePath: exe, headless: true });
    browsers.push(b);
    await scenario(name, b, url);
  }
} catch (e) {
  check("run", false, String(e));
} finally {
  for (const b of browsers) await b.close().catch(() => undefined);
  server.stop(true);
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall fallback e2e checks passed");
process.exit(failures ? 1 : 0);
