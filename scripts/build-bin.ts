// build-bin.ts - Build file chạy độc lập cho Windows + macOS vào dist/ (nhúng sẵn giao diện).

import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const targets = [
  ["bun-windows-x64", "MuBMD-editor-windows-x64.exe"],
  ["bun-darwin-arm64", "MuBMD-editor-macos-arm64"],
  ["bun-darwin-x64", "MuBMD-editor-macos-x64"],
] as const;

const run = async (cmd: string[]) => {
  const code = await Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) process.exit(code);
};

await run(["bun", "scripts/build-web.ts", "--minify"]);
for (const [target, out] of targets) {
  await run(["bun", "build", "--compile", "--minify", `--target=${target}`, `--outfile=dist/${out}`, "src/server/main.ts"]);
}
console.log("Đã build xong vào dist/.");
