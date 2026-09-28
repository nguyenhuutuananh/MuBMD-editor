// browsers.ts - Find Playwright's own browser builds (any installed revision, newest first).
// Install with `bunx playwright-core install chromium firefox webkit`.
// Chrome for Testing is preferred over the installed Google Chrome so local runs match CI.
// (Chromium 153 crashes when an OPFS folder handle is read back from IndexedDB after a reload;
// web/src/lib/handleDb.ts therefore stores OPFS handles by path.)

import * as fs from "node:fs";
import * as path from "node:path";
import { type BrowserType, chromium } from "playwright-core";

export function installed(type: BrowserType): string | null {
  if (type === chromium && process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const exact = type.executablePath();
  if (fs.existsSync(exact)) return exact;
  const name = type.name();
  const idx = exact.indexOf(`${path.sep}${name}-`);
  if (idx < 0) return null;
  const base = exact.slice(0, idx); // …/ms-playwright
  if (!fs.existsSync(base)) return null;
  const revs = fs.readdirSync(base).filter((d) => new RegExp(`^${name}-\\d+$`).test(d)).sort().reverse();
  for (const rev of revs) {
    const candidate = exact.replace(new RegExp(`${name}-\\d+`), rev);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Launch options for Chromium: Chrome for Testing if installed, else the installed Google Chrome.
export function chromiumOptions(): Parameters<typeof chromium.launch>[0] {
  const bundled = installed(chromium);
  if (bundled) return { executablePath: bundled, headless: true };
  console.log("(Chrome for Testing not found - using the installed Google Chrome)");
  return { channel: "chrome", headless: true };
}
