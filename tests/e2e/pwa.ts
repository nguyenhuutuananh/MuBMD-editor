// pwa.ts - End-to-end test of the BUILT web version (build/web-static) served under a sub-path like
// GitHub Pages (/MuBMD-editor/): installable manifest, service worker, working offline, and the
// "new version" update flow. Uses the same OPFS picker hook as web.ts.
//   bun tests/e2e/pwa.ts [screenshot-dir]      (builds first)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { sampleFiles } from "../fixtures/sampleItems";
import { chromiumOptions } from "./browsers";

const ROOT = path.join(import.meta.dir, "../..");
const PORT = 4863;
const SUBPATH = "/MuBMD-editor/";
const URL = `http://localhost:${PORT}${SUBPATH}`;
const SHOTS = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-pwa-e2e-"));
const DIST = path.join(ROOT, "build/web-static");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let preview: ReturnType<typeof Bun.spawn> | null = null;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const rowSel = (n: number) => `[data-testid=grid] [data-slot] >> nth=${n}`;
const text = async (p: Page, sel: string) => ((await p.textContent(sel)) ?? "").trim();

async function run(cmd: string[], env: Record<string, string> = {}) {
  const code = await Bun.spawn(cmd, { cwd: ROOT, stdout: "ignore", stderr: "inherit", env: { ...process.env, ...env } }).exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code})`);
}

async function startPreview() {
  preview = Bun.spawn(
    ["node", path.join(ROOT, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PORT), "--strictPort", "--base", SUBPATH],
    { cwd: ROOT, stdout: "ignore", stderr: "ignore", env: { ...process.env, VITE_TARGET: "web" } },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("vite preview did not start");
}

async function main(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __MUBMD_TEST_PICK__?: (req: { mode: string }) => Promise<FileSystemHandle> };
    w.__MUBMD_TEST_PICK__ = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("MU", { create: true });
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));

  // 1. Served under a sub-path; the service worker installs and controls the page
  await p.goto(URL);
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForTimeout(500);
  check("first install does not reload the page", await p.evaluate(() => performance.getEntriesByType("navigation").length === 1 && !!document.querySelector("[data-testid=pick]")));
  await p.reload();
  const controlled = await p.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "");
  check("service worker controls the page", controlled.endsWith(`${"/MuBMD-editor/"}sw.js`), controlled);

  // 2. Installable according to Chrome
  const cdp = await ctx.newCDPSession(p);
  const manifest = (await cdp.send("Page.getAppManifest")) as { url: string; errors: unknown[] };
  const installability = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  check("manifest found without errors", manifest.url.endsWith("/MuBMD-editor/manifest.webmanifest") && manifest.errors.length === 0, manifest.url);
  // "in-incognito" only reflects Playwright's throw-away browser profile, not the site.
  const installErrors = installability.installabilityErrors.map((e) => e.errorId).filter((id) => id !== "in-incognito");
  check("installable (no installability errors)", installErrors.length === 0, installErrors.join(", "));

  // 3. The built app works: open the sample game folder through the OPFS "folder"
  await p.evaluate(async (files) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ["MU", "Data", "Items"]) dir = await dir.getDirectoryHandle(part, { create: true });
    for (const [name, text] of Object.entries(files)) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }, sampleFiles());
  await p.click("[data-testid=pick]");
  await p.waitForSelector(rowSel(0));
  check("built app opens the game folder", (await text(p, "[data-testid=result-count]")) === "488 rows");

  // 4. Offline: the app shell and the file still open
  await ctx.setOffline(true);
  await p.reload();
  await p.waitForSelector("[data-testid=recent]").catch(async (e) => {
    await p.screenshot({ path: path.join(SHOTS, "pwa-offline-failed.png") });
    const state = await p.evaluate(() => ({ body: document.body.innerText.slice(0, 200), controller: !!navigator.serviceWorker.controller, recent: localStorage.getItem("mubmd.recent") }));
    throw new Error(`${(e as Error).message} - ${JSON.stringify(state)}`);
  });
  await p.click("[data-testid=recent]");
  await p.waitForSelector(rowSel(0));
  check("works offline (reload + reopen from recent)", (await text(p, "[data-testid=result-count]")) === "488 rows");
  await p.goto(`${URL}?fallback`);
  await p.waitForSelector("[data-testid=fallback-hint]");
  check("offline navigation with a query string (?fallback)", true);
  await p.screenshot({ path: path.join(SHOTS, "pwa-offline.png") });
  await ctx.setOffline(false);

  // 5. A new version: the page offers a reload, and reloading switches to it
  await p.goto(URL);
  await p.waitForSelector("[data-testid=pick]");
  const oldCache = await p.evaluate(async () => (await caches.keys()).find((k) => k.startsWith("mubmd-")));
  fs.appendFileSync(path.join(DIST, "sw.js"), "\n// new version (e2e)\n"); // any byte change = a new worker
  await p.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  const offer = p.locator("[data-sonner-toast]", { hasText: "A new version of MuBMD-editor is ready." });
  await offer.waitFor();
  check("update offered", true);
  await Promise.all([p.waitForEvent("load"), offer.locator("button", { hasText: "Reload" }).click()]);
  await p.waitForSelector("[data-testid=pick]");
  const newCache = await p.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("mubmd-")));
  // same file list -> same cache name; what matters is that the new worker took over after "Reload"
  const scriptChanged = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const res = await fetch(reg!.active!.scriptURL, { cache: "no-store" });
    return (await res.text()).includes("new version (e2e)") && !reg!.waiting;
  });
  check("reload switches to the new version", scriptChanged && newCache.length === 1, `${oldCache} -> ${newCache}`);

  check("no JavaScript errors", errors.length === 0, errors.join(" | "));
}

const timer = setTimeout(() => {
  console.log("✗ timed out");
  process.exit(1);
}, 240_000);

let browser: Browser | null = null;
try {
  await run(["bun", "scripts/build-web-static.ts"]);
  await startPreview();
  browser = await chromium.launch(chromiumOptions());
  await main(browser);
} catch (e) {
  failures++;
  console.log(`✗ error: ${(e as Error).message}`);
} finally {
  clearTimeout(timer);
  await (browser as Browser | null)?.close().catch(() => undefined);
  // Wait until the server has really exited, so a following run can take the port again.
  const server = preview as ReturnType<typeof Bun.spawn> | null;
  server?.kill();
  await server?.exited;
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
