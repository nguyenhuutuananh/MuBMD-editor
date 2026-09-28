// build-web-static.ts - Build the web version (static PWA) into build/web-static/.
// Deployed to GitHub Pages by .github/workflows/release.yml; any static host works (relative paths).

import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const code = await Bun.spawn(["node", path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, VITE_TARGET: "web" },
}).exited;
process.exit(code);
