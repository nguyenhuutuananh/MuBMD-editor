// dev.ts - Chạy server (4817, tự nạp lại khi sửa code) + Vite dev (5173, HMR) cùng lúc.
//   bun run dev [đường/dẫn/Item.bmd]   (mặc định data/Item.bmd)

import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const file = process.argv[2] ?? "data/Item.bmd";

await Bun.spawn(["bun", "scripts/build-web.ts", "--stub"], { cwd: root, stdout: "inherit", stderr: "inherit" }).exited;

const procs = [
  Bun.spawn(["bun", "--watch", "src/server/main.ts", file, "--no-open"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
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
