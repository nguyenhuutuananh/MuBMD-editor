// app.ts - HTTP handling: JSON API + serving the UI. Kept separate from Bun.serve so it is testable.

import { dirname as pathDirname, join as pathJoin } from "node:path";
import { AppError, type ErrorCode, type ErrorParams, NameValidationError, isStatus } from "../core";
import {
  type EditRequest,
  type ErrorResponse,
  type GlossaryInfo,
  isLang,
  type ItemsResponse,
  type Lang,
  type OpenRequest,
  type PickKind,
  type PickResponse,
  type RevertRequest,
  type SaveRequest,
  type SaveResponse,
  type StateResponse,
} from "../shared/api";
import { pickFile, pickSaveFile } from "./filePicker";
import { loadGlossaryFile, saveGlossaryFile } from "../session/glossaryFiles";
import { itemsResponse as buildItemsResponse, saveResponse, stateResponse } from "../session/responses";
import { NoFileError, Session } from "../session/session";
import { NodeStorage } from "./nodeStorage";

// Built UI (Vite), keyed by URL path ("/index.html", "/assets/index-abc.js").
export interface WebAsset {
  type: string;
  body: string;
  base64: boolean;
}
export type WebAssets = Record<string, WebAsset>;

export interface AppOptions {
  assets: WebAssets;
  version: string;
  session?: Session;
  pick?: (lang: Lang, kind: PickKind, dir?: string) => Promise<string | null>;
  pickSave?: (defaultPath: string, lang: Lang, kind: "bmd" | "tsv" | "glossary") => Promise<string | null>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (status: number, code: ErrorCode, error: string, params: ErrorParams = {}, extra: Partial<ErrorResponse> = {}) =>
  json({ error, code, params, ...extra } satisfies ErrorResponse, status);

// Only accept requests addressed to localhost (DNS-rebinding protection: a foreign site pointing
// its domain at 127.0.0.1 to call the API and read local files).
function isLocalHost(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// State-changing requests must be JSON: browsers require a CORS preflight for this
// content type, so other websites cannot send them silently.
function isJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  "invalid-name": 422,
  "import-changed": 409,
  dirty: 409,
  conflict: 409,
  "no-file": 409,
  "picker-unsupported": 501,
  "picker-failed": 500,
  "save-verify-failed": 500,
  internal: 500,
};

const ERRNO: Record<string, ErrorCode> = {
  ENOENT: "file-not-found",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EISDIR: "is-directory",
  ENOSPC: "disk-full",
};

// Turn an error into a coded response: user errors -> 4xx, everything else -> 500.
function errorResponse(e: unknown): Response {
  if (e instanceof NameValidationError) {
    return fail(422, e.code, e.message, e.params, { issues: e.check.issues });
  }
  if (e instanceof AppError) return fail(STATUS[e.code] ?? 400, e.code, e.message, e.params);
  const errno = (e as NodeJS.ErrnoException)?.code;
  if (errno && ERRNO[errno]) {
    const path = (e as NodeJS.ErrnoException).path ?? "";
    return fail(400, ERRNO[errno]!, (e as Error).message, path ? { path } : {});
  }
  console.error(e);
  const detail = e instanceof Error ? e.message : String(e);
  return fail(500, "internal", detail, { detail });
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function createApp(opts: AppOptions) {
  const session = opts.session ?? new Session(new NodeStorage());
  const pick = opts.pick ?? pickFile;
  const pickSave = opts.pickSave ?? pickSaveFile;

  const state = () => stateResponse(session, opts.version);
  const itemsResponse = () => buildItemsResponse(session);

  // Used at startup when a path is given on the command line.
  async function openPath(path: string): Promise<Response> {
    try {
      await session.open(path);
      return json(state());
    } catch (e) {
      return errorResponse(e);
    }
  }

  type Handler = (body: Record<string, unknown>) => unknown;

  const langOf = (b: Record<string, unknown>): Lang => (isLang(b.lang) ? b.lang : "en");
  const slotsOf = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
  const pathOf = (b: Record<string, unknown>) => {
    const p = str(b.path).trim();
    if (!p) throw new AppError("missing-path", "Missing file path.");
    return p;
  };
  const openDir = () => (session.file ? pathDirname(session.file.path) : undefined);

  const posts: Record<string, Handler> = {
    "/api/open": async (b) => {
      const path = str((b as Partial<OpenRequest>).path).trim();
      if (!path) return fail(400, "missing-path", "Missing file path.");
      await session.open(path, { discard: b.discard === true });
      return state();
    },
    "/api/pick": async (b) => {
      const kinds: PickKind[] = ["bmd-file", "tsv", "reference", "glossary", "compare"];
      const kind: PickKind = kinds.includes(b.kind as PickKind) ? (b.kind as PickKind) : "bmd";
      return { path: await pick(langOf(b), kind, openDir()) } satisfies PickResponse;
    },
    "/api/pick-save": async (b) => {
      if (!session.file) throw new NoFileError();
      const kind = b.kind === "tsv" || b.kind === "glossary" ? b.kind : "bmd";
      const name = str(b.defaultName).replace(/[\\/:*?"<>|]/g, "_").trim();
      const def = name ? pathJoin(pathDirname(session.file.path), name) : session.file.path;
      return { path: await pickSave(def, langOf(b), kind) } satisfies PickResponse;
    },
    "/api/edit": (b) => {
      const r = b as Partial<EditRequest>;
      if (typeof r.name !== "string") return fail(400, "missing-name", "Missing name.");
      return session.edit(Number(r.slot), r.name, str(r.translator));
    },
    "/api/revert": (b) => session.revert(Number((b as Partial<RevertRequest>).slot), str(b.translator)),
    "/api/status": (b) => {
      if (!isStatus(b.status)) return fail(400, "bad-json", "Invalid status.");
      return session.setStatus(slotsOf(b.slots), b.status, str(b.translator));
    },
    "/api/note": (b) => session.setNote(Number(b.slot), str(b.note), str(b.translator)),
    "/api/reference": async (b) => ({ reference: await session.setReference(b.path ? pathOf(b) : null) }),
    // The glossary is a standalone file shared by the team (not tied to the open Item.bmd).
    "/api/glossary/load": (b): Promise<GlossaryInfo> => loadGlossaryFile(session.storage, pathOf(b)),
    "/api/glossary/save": (b): Promise<GlossaryInfo> =>
      saveGlossaryFile(session.storage, pathOf(b), Array.isArray(b.entries) ? b.entries : []),
    "/api/export": (b) => session.exportTsv(pathOf(b), slotsOf(b.slots)),
    "/api/import/preview": (b) => session.previewImport(pathOf(b)),
    "/api/import/apply": (b) => session.applyImport(pathOf(b), str(b.token), slotsOf(b.take), str(b.translator)),
    "/api/undo": () => session.undo(),
    "/api/redo": () => session.redo(),
    "/api/draft/restore": () => session.restoreDraft(),
    "/api/draft/discard": async () => {
      await session.discardDraft();
      return { ok: true };
    },
    "/api/save": async (b) => {
      const r = b as Partial<SaveRequest>;
      return saveResponse(session, await session.save({ path: str(r.path).trim() || undefined, force: r.force === true }));
    },
  };

  async function handle(req: Request): Promise<Response> {
    if (!isLocalHost(req)) return fail(403, "not-local", "Only reachable via localhost.");
    const { pathname } = new URL(req.url);

    if (req.method === "GET") {
      const asset = opts.assets[pathname === "/" ? "/index.html" : pathname];
      if (asset) {
        // Files in /assets/ have a content hash in their name -> cache forever; index.html is always revalidated.
        const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        const body = asset.base64 ? Buffer.from(asset.body, "base64") : asset.body;
        return new Response(body, { headers: { "content-type": asset.type, "cache-control": cache } });
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
      if (!isJson(req)) return fail(415, "unsupported-media", "Content-Type must be application/json.");
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") return fail(400, "bad-json", "Invalid JSON body.");
      try {
        const out = await handler(body as Record<string, unknown>);
        return out instanceof Response ? out : json(out);
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (pathname.startsWith("/api/")) return fail(404, "unknown-api", "No such API.");
    return new Response("Not found", { status: 404 });
  }

  return { handle, session, openPath };
}
