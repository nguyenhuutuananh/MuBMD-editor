// dev.ts - Development: the Bun API server (4837, restarts on code changes) + Vite (5193, HMR).
// Two ports on purpose: the API runs on Bun exactly like in releases; Vite only serves the UI
// and proxies /api. Releases (`bun run start` / the executable) use a single port.
//   bun run dev [path/to/Localization] [--locale vi]
//   (defaults to data/Localization, created from the test sample if missing)

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const args = process.argv.slice(2);
const folder = args[0] && !args[0].startsWith("--") ? args[0] : "data/Localization";

// No game data is committed: give a fresh clone something to open.
if (folder === "data/Localization" && !fs.existsSync(path.join(root, folder))) {
  const { writeSampleLocalization } = await import("../tests/fixtures/sampleLocalization");
  writeSampleLocalization(path.join(root, folder));
  console.log(`Created a sample ${folder}.`);
}

await Bun.spawn(["bun", "scripts/build-web.ts", "--stub"], { cwd: root, stdout: "inherit", stderr: "inherit" }).exited;

const rest = args[0] === folder ? args.slice(1) : args;
const procs = [
  Bun.spawn(["bun", "--watch", "src/server/main.ts", folder, ...rest, "--no-open"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
  // Vite needs Node (>= 20.19).
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--open"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
