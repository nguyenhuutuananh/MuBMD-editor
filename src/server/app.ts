// app.ts - Xử lý HTTP: API JSON + phục vụ giao diện. Tách khỏi Bun.serve để test được.

import { BmdFormatError, NameValidationError } from "../core";
import type {
  EditRequest,
  ErrorCode,
  ErrorResponse,
  ItemsResponse,
  OpenRequest,
  PickResponse,
  RevertRequest,
  SaveRequest,
  SaveResponse,
  StateResponse,
} from "../shared/api";
import { FilePickerUnavailableError, pickFile, pickSaveFile } from "./filePicker";
import { ConflictError, DirtyError, NoFileError, Session } from "./session";
import { FileLockedError } from "./storage";

export interface WebAssets {
  html: string;
  js: string;
  css: string;
}

export interface AppOptions {
  assets: WebAssets;
  version: string;
  session?: Session;
  pick?: () => Promise<string | null>;
  pickSave?: (defaultPath: string) => Promise<string | null>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (error: string, status: number, extra: Omit<ErrorResponse, "error"> = {}) =>
  json({ error, ...extra } satisfies ErrorResponse, status);

// Chỉ nhận request gửi tới localhost (chống DNS rebinding: trang web lạ trỏ
// tên miền của nó về 127.0.0.1 rồi gọi API đọc file trên máy).
function isLocalHost(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// Request thay đổi trạng thái phải là JSON: trình duyệt bắt buộc preflight CORS
// cho content-type này nên trang web khác không gửi ngầm được.
function isJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

function fsMessage(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "Không tìm thấy file.";
  if (code === "EACCES" || code === "EPERM") return "Không có quyền đọc/ghi file.";
  if (code === "EISDIR") return "Đường dẫn là thư mục, không phải file.";
  if (code === "ENOSPC") return "Ổ đĩa đầy.";
  return e instanceof Error ? e.message : String(e);
}

// Chuyển lỗi thành response: lỗi người dùng -> 4xx có mã, còn lại -> 500.
function errorResponse(e: unknown): Response {
  const code = (c: ErrorCode) => ({ code: c });
  if (e instanceof NameValidationError) {
    return fail(e.message, 422, { ...code("invalid-name"), issues: e.check.issues });
  }
  if (e instanceof DirtyError) return fail(e.message, 409, code("dirty"));
  if (e instanceof ConflictError) return fail(e.message, 409, code("conflict"));
  if (e instanceof NoFileError) return fail(e.message, 409);
  if (e instanceof BmdFormatError || e instanceof FileLockedError || e instanceof RangeError) return fail(e.message, 400);
  if ((e as NodeJS.ErrnoException)?.code) return fail(fsMessage(e), 400);
  console.error(e);
  return fail(e instanceof Error ? e.message : String(e), 500);
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function createApp(opts: AppOptions) {
  const session = opts.session ?? new Session();
  const pick = opts.pick ?? pickFile;
  const pickSave = opts.pickSave ?? pickSaveFile;

  const state = (): StateResponse => ({ file: session.file, version: opts.version });

  function itemsResponse(): ItemsResponse {
    const file = session.file;
    if (!file) throw new NoFileError();
    return { file, items: session.items(), edits: session.edits(), status: session.status(), draft: session.draftInfo() };
  }

  // Dùng khi khởi động với đường dẫn trên dòng lệnh.
  function openPath(path: string): Response {
    try {
      session.open(path);
      return json(state());
    } catch (e) {
      return errorResponse(e);
    }
  }

  type Handler = (body: Record<string, unknown>) => unknown;

  const posts: Record<string, Handler> = {
    "/api/open": (b) => {
      const path = str((b as Partial<OpenRequest>).path).trim();
      if (!path) return fail("Thiếu đường dẫn file.", 400);
      session.open(path, { discard: b.discard === true });
      return state();
    },
    "/api/pick": async () => ({ path: await pick() }) satisfies PickResponse,
    "/api/pick-save": async () => {
      if (!session.file) throw new NoFileError();
      return { path: await pickSave(session.file.path) } satisfies PickResponse;
    },
    "/api/edit": (b) => {
      const r = b as Partial<EditRequest>;
      if (typeof r.name !== "string") return fail("Thiếu tên.", 400);
      return session.edit(Number(r.slot), r.name, str(r.translator));
    },
    "/api/revert": (b) => session.revert(Number((b as Partial<RevertRequest>).slot), str(b.translator)),
    "/api/undo": () => session.undo(),
    "/api/redo": () => session.redo(),
    "/api/draft/restore": () => session.restoreDraft(),
    "/api/draft/discard": () => {
      session.discardDraft();
      return { ok: true };
    },
    "/api/save": (b) => {
      const r = b as Partial<SaveRequest>;
      const result = session.save({ path: str(r.path).trim() || undefined, force: r.force === true });
      return { ...result, status: session.status() } satisfies SaveResponse;
    },
  };

  async function handle(req: Request): Promise<Response> {
    if (!isLocalHost(req)) return fail("Chỉ truy cập qua localhost.", 403);
    const { pathname } = new URL(req.url);

    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(opts.assets.html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/app.js") {
        return new Response(opts.assets.js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (pathname === "/styles.css") {
        return new Response(opts.assets.css, { headers: { "content-type": "text/css; charset=utf-8" } });
      }
      if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (pathname === "/api/state") return json(state());
      if (pathname === "/api/items") {
        try {
          return json(itemsResponse());
        } catch (e) {
          return errorResponse(e);
        }
      }
    }

    const handler = req.method === "POST" ? posts[pathname] : undefined;
    if (handler) {
      if (!isJson(req)) return fail("Cần Content-Type: application/json.", 415);
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") return fail("Body JSON không hợp lệ.", 400);
      try {
        const out = await handler(body as Record<string, unknown>);
        return out instanceof Response ? out : json(out);
      } catch (e) {
        if (e instanceof FilePickerUnavailableError) return fail(e.message, 501);
        return errorResponse(e);
      }
    }

    if (pathname.startsWith("/api/")) return fail("Không có API này.", 404);
    return new Response("Not found", { status: 404 });
  }

  return { handle, session, openPath };
}
