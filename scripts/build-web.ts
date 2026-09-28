// build-web.ts - Đóng gói giao diện web/ vào build/web/ (server nhúng các file này khi chạy/compile).

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const outdir = path.join(root, "build/web");
fs.mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "web/main.ts")],
  target: "browser",
  minify: process.argv.includes("--minify"),
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// Sinh module TypeScript chứa sẵn nội dung giao diện: server import file này
// nên `bun build --compile` tự nhúng giao diện vào file chạy.
const assets = {
  html: fs.readFileSync(path.join(root, "web/index.html"), "utf-8"),
  js: await result.outputs[0]!.text(),
  css: fs.readFileSync(path.join(root, "web/styles.css"), "utf-8"),
};
fs.writeFileSync(
  path.join(outdir, "assets.ts"),
  "// File sinh tự động bởi scripts/build-web.ts - không sửa tay.\n" +
    `export const html = ${JSON.stringify(assets.html)};\n` +
    `export const js = ${JSON.stringify(assets.js)};\n` +
    `export const css = ${JSON.stringify(assets.css)};\n`,
);
console.log(`Đã build giao diện vào ${path.relative(root, outdir)}/`);
