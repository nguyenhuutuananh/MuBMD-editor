// build-bin.ts - Release build: standalone executables (UI embedded) for Windows + macOS, each zipped
// together with the user guides, plus SHA256SUMS.txt.
//
//   bun run build                         all targets into dist/
//   bun run build -- --out ../releases    another output folder (e.g. outside Google Drive)
//   bun run build -- --only windows-x64   one target (windows-x64 | macos-arm64 | macos-x64)

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pkg from "../package.json";

const root = path.join(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = path.resolve(root, opt("--out") ?? "dist");
const only = opt("--only");

const TARGETS = [
  { id: "windows-x64", bun: "bun-windows-x64", exe: "MuBMD-editor.exe", crlf: true },
  { id: "macos-arm64", bun: "bun-darwin-arm64", exe: "MuBMD-editor", crlf: false },
  { id: "macos-x64", bun: "bun-darwin-x64", exe: "MuBMD-editor", crlf: false },
].filter((t) => !only || t.id === only);
if (!TARGETS.length) {
  console.error(`Unknown target: ${only}`);
  process.exit(2);
}

const run = async (cmd: string[], cwd = root) => {
  const code = await Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) process.exit(code);
};

const guides = ["HUONG-DAN-SU-DUNG.txt", "USER-GUIDE.txt"].map((f) => ({
  name: f,
  text: fs.readFileSync(path.join(root, "docs", f), "utf-8").replaceAll("{{VERSION}}", pkg.version),
}));

await run(["bun", "scripts/build-web.ts"]);
fs.mkdirSync(outDir, { recursive: true });
const sums: string[] = [];

for (const t of TARGETS) {
  const name = `MuBMD-editor-${pkg.version}-${t.id}`;
  const dir = path.join(outDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  await run(["bun", "build", "--compile", "--minify", `--target=${t.bun}`, `--outfile=${path.join(dir, t.exe)}`, "src/server/main.ts"]);
  fs.chmodSync(path.join(dir, t.exe), 0o755);
  // Notepad on older Windows needs CRLF line endings.
  for (const g of guides) fs.writeFileSync(path.join(dir, g.name), t.crlf ? g.text.replace(/\r?\n/g, "\r\n") : g.text);

  const zip = `${name}.zip`;
  fs.rmSync(path.join(outDir, zip), { force: true });
  await run(["zip", "-qry", zip, name], outDir); // zip keeps the executable bit for macOS
  fs.rmSync(dir, { recursive: true, force: true });

  const hash = createHash("sha256").update(fs.readFileSync(path.join(outDir, zip))).digest("hex");
  sums.push(`${hash}  ${zip}`);
  console.log(`  ${zip}  (${(fs.statSync(path.join(outDir, zip)).size / 1e6).toFixed(1)} MB)`);
}

fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`Build finished: ${outDir}`);
