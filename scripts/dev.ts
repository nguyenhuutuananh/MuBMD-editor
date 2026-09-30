// dev.ts - Development: the Bun API server (4817, restarts on code changes) + Vite (5173, HMR).
// Two ports on purpose: the API runs on Bun exactly like in releases; Vite only serves the UI
// and proxies /api. Releases (`bun run start` / the executable) use a single port.
//   bun run dev [path/to/game]   (defaults to data/game; created from the test sample if missing)

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const file = process.argv[2] ?? "data/game";

// No game data is committed: give a fresh clone something to open (real Vietnamese names, fake stats).
if (!process.argv[2] && !fs.existsSync(path.join(root, file))) {
  const { writeSampleGame } = await import("../tests/fixtures/sampleItems");
  writeSampleGame(path.join(root, file));
  console.log(`Created a sample game folder ${file} (real Vietnamese names, fake stats).`);
}

await Bun.spawn(["bun", "scripts/build-web.ts", "--stub"], { cwd: root, stdout: "inherit", stderr: "inherit" }).exited;

const procs = [
  Bun.spawn(["bun", "--watch", "src/server/main.ts", file, "--no-open"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
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
