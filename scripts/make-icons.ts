// make-icons.ts - Rasterize web/public/favicon.svg into the PWA / iOS icon PNGs (web/public/icons/).
//   bun scripts/make-icons.ts   (needs Chrome for Testing: bunx playwright-core install chromium)

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright-core";
import { chromiumOptions } from "../tests/e2e/browsers";

const root = path.join(import.meta.dir, "..");
const svgPath = path.join(root, "web/public/favicon.svg");
const outDir = path.join(root, "web/public/icons");
const svg = fs.readFileSync(svgPath, "utf-8");
const b = await chromium.launch(chromiumOptions());
const shots: [string, number, number][] = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.1], // maskable: keep the art inside the 80% safe zone
  ["apple-touch-icon.png", 180, 0],
];
for (const [name, size, pad] of shots) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - 2 * pad));
  const bg = pad ? "#1d6b73" : "transparent";
  await p.setContent(`<html><body style="margin:0;background:${bg};display:grid;place-items:center;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await p.screenshot({ path: `${outDir}/${name}`, omitBackground: !pad });
  await p.close();
}
await b.close();
console.log("icons written");
