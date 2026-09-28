// main.ts - Điểm vào: chạy server trên 127.0.0.1 và mở trình duyệt.
//
//   bun run dev                        (server + Vite dev server)
//   bun run start                      (build giao diện rồi chạy như bản phát hành)
//   MuBMD-editor [Item.bmd] [--port N] [--no-open]

import { assets } from "../../build/web/assets"; // sinh bởi scripts/build-web.ts
import pkg from "../../package.json";
import { createApp } from "./app";

const DEFAULT_PORT = 4817;

function parseArgs(argv: string[]) {
  let file: string | undefined;
  let port = DEFAULT_PORT;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--no-open") open = false;
    else if (!a.startsWith("--")) file = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Cổng không hợp lệ: ${port}`);
  return { file, port, open };
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // không mở được thì người dùng tự mở link in ra bên dưới
  }
}

// Thử lần lượt các cổng tiếp theo nếu cổng mặc định đang bận (ví dụ đang chạy 2 bản).
function serve(handle: (req: Request) => Promise<Response>, port: number) {
  for (let p = port; p < port + 20; p++) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port: p, fetch: handle });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`Không tìm được cổng trống từ ${port} đến ${port + 19}.`);
}

const args = parseArgs(process.argv.slice(2));
const app = createApp({ assets, version: pkg.version });
if (!assets["/index.html"]) console.log("(Chưa build giao diện - chạy `bun run build:web`, hoặc dùng `bun run dev` để mở giao diện qua Vite.)");

if (args.file) {
  const res = app.openPath(args.file);
  if (!res.ok) console.error(`Không mở được ${args.file}: ${((await res.json()) as { error: string }).error}`);
}

const server = serve(app.handle, args.port);
const url = `http://localhost:${server.port}/`;
console.log(`MuBMD-editor ${pkg.version} đang chạy tại ${url}`);
console.log("Giữ cửa sổ này mở trong lúc dịch. Nhấn Ctrl+C để thoát.");
if (args.open) openBrowser(url);

// Thay đổi chưa lưu vẫn còn trong bản nháp (draft.json), mở lại file sẽ được hỏi khôi phục.
process.on("SIGINT", () => {
  const dirty = app.session.status().dirtyCount;
  if (dirty) console.log(`\nCòn ${dirty} thay đổi chưa lưu - đã giữ trong bản nháp, lần sau mở lại file sẽ được hỏi khôi phục.`);
  process.exit(0);
});
