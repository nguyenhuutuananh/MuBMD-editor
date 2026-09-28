// dev-web.ts - Development of the web build: Vite only (port 5174); the Session runs in the browser.
// Open it in Chrome or Edge (File System Access API) and choose a folder that contains Item.bmd.

import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const vite = Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--open"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: { ...process.env, VITE_TARGET: "web" },
});
process.on("SIGINT", () => vite.kill("SIGINT"));
process.exit(await vite.exited);
