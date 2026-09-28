// web-fallback.ts - End-to-end test of the web build WITHOUT the File System Access API (upload into
// IndexedDB, download results). Runs on:
//   - Playwright's Chrome for Testing with "?fallback" (forces the mode)
//   - Playwright's Firefox and WebKit (Safari's engine), where the mode is detected automatically
//     (each skipped if not installed: `bunx playwright-core install firefox webkit`)
//   bun tests/e2e/web-fallback.ts [screenshot-dir]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type Page, chromium, firefox, webkit } from "playwright-core";
import { ItemBmd } from "../../src/core";
import { buildSampleBmd } from "../fixtures/sampleBmd";
import { chromiumOptions, installed } from "./browsers";

const ROOT = path.join(import.meta.dir, "../..");
const PORT = 4862;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-fallback-e2e-"));
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let vite: ReturnType<typeof Bun.spawn> | null = null;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const rowSel = (n: number) => `[data-testid=grid] [data-slot] >> nth=${n}`;
const EDITOR = "[data-testid=inline-editor] input";
const text = async (p: Page, sel: string) => ((await p.textContent(sel)) ?? "").trim();
const waitText = (p: Page, sel: string, want: string) =>
  p.waitForFunction(([s, w]) => document.querySelector(s!)?.textContent?.trim() === w, [sel, want]);

async function toastWith(p: Page, needle: string): Promise<string> {
  const t = p.locator("[data-sonner-toast]", { hasText: needle }).first();
  try {
    await t.waitFor();
    return ((await t.textContent()) ?? "").trim();
  } catch {
    return `(not found; showing: ${(await p.locator("[data-sonner-toast]").allTextContents()).join(" | ") || "none"})`;
  }
}

// Click `trigger`, answer the file chooser with (name, bytes).
async function upload(p: Page, trigger: () => Promise<unknown>, name: string, bytes: Uint8Array) {
  const chooser = p.waitForEvent("filechooser");
  await trigger();
  await (await chooser).setFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
}

// Run `action`, return the downloaded file (name + bytes), or null if nothing was downloaded.
async function downloadOf(p: Page, action: () => Promise<unknown>, timeout = 8000): Promise<{ name: string; bytes: Uint8Array } | null> {
  const dl = p.waitForEvent("download", { timeout }).catch(() => null);
  await action();
  const d = await dl;
  if (!d) return null;
  const file = path.join(SHOTS, `dl-${Date.now()}-${d.suggestedFilename()}`);
  await d.saveAs(file);
  return { name: d.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(file)) };
}

async function scenario(label: string, browser: Browser, url: string) {
  console.log(`\n-- ${label}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("dialog", (d) => d.accept().catch(() => undefined)); // "leave site?" on reload with unsaved changes
  const mod = !label.startsWith("Chrome") && process.platform === "darwin" ? "Meta" : "Control";
  const choose = async (trigger: string, option: string) => {
    await p.click(`[data-testid=${trigger}]`);
    await p.click(`[data-testid=${option}]`);
    await p.waitForFunction(() => !document.querySelector("[role=menu], [role=listbox]"));
  };

  // 1. Fallback welcome screen
  await p.goto(url);
  await p.waitForSelector("[data-testid=pick]");
  check(`${label}: fallback hint, upload button`, (await p.isVisible("[data-testid=fallback-hint]")) && (await text(p, "[data-testid=pick]")) === "Choose Item.bmd…");

  // 2. Upload Item.bmd -> a copy in this browser
  await upload(p, () => p.click("[data-testid=pick]"), "Item.bmd", buildSampleBmd());
  await p.waitForSelector(rowSel(0));
  check(`${label}: uploaded copy opened`, (await text(p, "[data-testid=result-count]")) === "488 rows" && (await p.isVisible("[data-testid=browser-copy]")));

  // 3. Edit + save -> the updated Item.bmd is downloaded
  await p.click(rowSel(0));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  await p.keyboard.type("Fallback Tester");
  await p.keyboard.press("Enter");
  await p.waitForSelector(EDITOR);
  await p.fill(EDITOR, "Chùy Tải Về");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:1"]`);
  await p.keyboard.press("Escape");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await p.focus("[data-testid=grid]");
  const saved = await downloadOf(p, () => p.keyboard.press(`${mod}+s`));
  const savedBmd = saved ? ItemBmd.parse(saved.bytes) : null;
  check(`${label}: save downloads Item.bmd`, saved?.name === "Item.bmd" && savedBmd?.getName(0).text === "Chùy Tải Về" && savedBmd.checksumValid === true);
  const toast = await toastWith(p, "Downloaded Item.bmd");
  check(`${label}: toast says where to copy it`, toast.includes("Data/Local"), toast);
  await p.screenshot({ path: path.join(SHOTS, `${label.replace(/\W+/g, "-")}-saved.png`) });

  // 4. A status-only save does not download
  await p.click(rowSel(2));
  await p.keyboard.press("Alt+Digit3");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  const none = await downloadOf(p, () => p.keyboard.press(`${mod}+s`), 2500);
  check(`${label}: status-only save stays in the browser`, none === null);

  // 5. Draft + recent copy survive a reload
  await p.dblclick(rowSel(1));
  await p.fill(EDITOR, "Đoản Đao Nháp");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:2"]`);
  await p.keyboard.press("Escape");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await p.reload();
  await p.click("[data-testid=recent]");
  await p.waitForSelector("[data-testid=dialog]");
  await p.click("[data-testid=dialog-restore]");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  check(
    `${label}: reopened from the browser copy with its draft`,
    (await text(p, `[data-testid=grid] [data-slot='0'] > span:nth-child(3)`)) === "Chùy Tải Về" &&
      (await text(p, `[data-testid=grid] [data-slot='1'] > span:nth-child(3)`)) === "Đoản Đao Nháp",
  );

  // 6. Export TSV -> download
  await choose("actions", "action-export");
  await p.waitForSelector("[data-testid=export-dialog]");
  await p.click("[data-testid=export-named]");
  const tsv = await downloadOf(p, () => p.click("[data-testid=export-go]"));
  check(
    `${label}: export downloads a TSV with BOM`,
    !!tsv && tsv.name.endsWith(".tsv") && tsv.bytes[0] === 0xef && new TextDecoder().decode(tsv.bytes).startsWith("ItemType\tItemIndex\tName"),
    tsv?.name,
  );

  // 7. Import a teammate's TSV by uploading it
  const theirs = new TextEncoder().encode("ItemType\tItemIndex\tName\tBaseName\n0\t4\tĐao Sát Thủ Firefox\tĐao Sát Thủ\n");
  await upload(p, () => choose("actions", "action-import"), "theirs.tsv", theirs);
  await p.waitForSelector("[data-testid=import-dialog]");
  await p.click("[data-testid=import-apply]");
  await toastWith(p, "Imported 1 change");
  check(`${label}: import from an uploaded TSV`, (await text(p, `[data-testid=grid] [data-slot='4'] > span:nth-child(3)`)) === "Đao Sát Thủ Firefox");

  check(`${label}: no JavaScript errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function startVite() {
  vite = Bun.spawn(["node", path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, VITE_TARGET: "web" },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("vite did not start");
}

const timer = setTimeout(() => {
  console.log("✗ timed out");
  process.exit(1);
}, 240_000);

const browsers: Browser[] = [];
try {
  await startVite();
  const chromeBrowser = await chromium.launch(chromiumOptions());
  browsers.push(chromeBrowser);
  await scenario("Chrome ?fallback", chromeBrowser, `${BASE}?fallback`);

  const ff = installed(firefox);
  if (ff) {
    const ffBrowser = await firefox.launch({ executablePath: ff, headless: true });
    browsers.push(ffBrowser);
    await scenario("Firefox", ffBrowser, BASE);
  } else {
    console.log("\n-- Firefox not installed, skipped (bunx playwright-core install firefox)");
  }

  const wk = installed(webkit);
  if (wk) {
    const wkBrowser = await webkit.launch({ executablePath: wk, headless: true });
    browsers.push(wkBrowser);
    await scenario("WebKit (Safari)", wkBrowser, BASE);
  } else {
    console.log("\n-- WebKit not installed, skipped (bunx playwright-core install webkit)");
  }
} catch (e) {
  failures++;
  console.log(`✗ error: ${(e as Error).message}`);
} finally {
  clearTimeout(timer);
  for (const b of browsers) await b.close().catch(() => undefined);
  // Wait until the server has really exited, so a following run can take the port again.
  const server = vite as ReturnType<typeof Bun.spawn> | null;
  server?.kill();
  await server?.exited;
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
