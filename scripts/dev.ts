// dev.ts - Development: the Bun API server (4817, restarts on code changes) + Vite (5173, HMR).
// Two ports on purpose: the API runs on Bun exactly like in releases; Vite only serves the UI
// and proxies /api. Releases (`bun run start` / the executable) use a single port.
//   bun run dev [path/to/Item.bmd]   (defaults to data/Item.bmd)

import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const file = process.argv[2] ?? "data/Item.bmd";

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
