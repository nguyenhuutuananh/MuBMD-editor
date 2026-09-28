// build-web.ts - Build giao diện Vue (Vite) rồi sinh build/web/assets.ts chứa sẵn mọi file,
// để server import và `bun build --compile` nhúng thẳng giao diện vào file chạy.
//
//   bun scripts/build-web.ts          build thật
//   bun scripts/build-web.ts --stub   chỉ tạo assets.ts rỗng nếu chưa có (cho dev / typecheck)

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.join(root, "build/web-dist");
const outFile = path.join(root, "build/web/assets.ts");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const TEXT = new Set([".html", ".js", ".css", ".json", ".svg"]);

function write(assets: Record<string, { type: string; body: string; base64: boolean }>) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    "// File sinh tự động bởi scripts/build-web.ts - không sửa tay.\n" +
      "export interface WebAsset { type: string; body: string; base64: boolean }\n" +
      `export const assets: Record<string, WebAsset> = ${JSON.stringify(assets)};\n`,
  );
}

if (process.argv.includes("--stub")) {
  if (!fs.existsSync(outFile)) write({});
  process.exit(0);
}

const code = await Bun.spawn(["node", path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
}).exited;
if (code !== 0) process.exit(code);

const assets: Record<string, { type: string; body: string; base64: boolean }> = {};
const walk = (dir: string) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, f.name);
    if (f.isDirectory()) walk(abs);
    else {
      const ext = path.extname(f.name).toLowerCase();
      const rel = `/${path.relative(dist, abs).split(path.sep).join("/")}`;
      const isText = TEXT.has(ext);
      const buf = fs.readFileSync(abs);
      assets[rel] = {
        type: TYPES[ext] ?? "application/octet-stream",
        body: isText ? buf.toString("utf-8") : buf.toString("base64"),
        base64: !isText,
      };
    }
  }
};
walk(dist);
write(assets);
console.log(`Đã nhúng ${Object.keys(assets).length} file giao diện vào ${path.relative(root, outFile)}`);
