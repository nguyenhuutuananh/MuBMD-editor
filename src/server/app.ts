// app.ts - HTTP handling: JSON API + serving the UI. Kept separate from Bun.serve so it is testable.

import { dirname as pathDirname, join as pathJoin } from "node:path";
import { AppError, type ErrorCode, type ErrorParams, isStatus } from "../core";
import {
  type ErrorResponse,
  type GlossaryInfo,
  isLang,
  type KeyRef,
  type Lang,
  type PickKind,
  type PickResponse,
  type ProposalDecision,
  type SaveResponse,
  type StateResponse,
} from "../shared/api";
import { loadGlossaryFile, saveGlossaryFile } from "../session/glossaryFiles";
import { NoFolderError, Session } from "../session/session";
import { type SaveKind, pickFile, pickSaveFile } from "./filePicker";
import { hostPlatform } from "../session/itemsFolder";
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
  pickSave?: (defaultPath: string, lang: Lang, kind: SaveKind) => Promise<string | null>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (status: number, code: ErrorCode, error: string, params: ErrorParams = {}) =>
  json({ error, code, params } satisfies ErrorResponse, status);

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
  "no-folder": 409,
  dirty: 409,
  conflict: 409,
  "not-editable": 422,
  "resx-invalid-char": 422,
  "file-locked": 423,
  "import-changed": 409,
  "save-verify-failed": 500,
  "file-not-found": 404,
  "picker-unsupported": 501,
  "picker-failed": 500,
  internal: 500,
};

const ERRNO: Record<string, ErrorCode> = {
  ENOENT: "file-not-found",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EISDIR: "is-directory",
  ENOTDIR: "not-a-folder",
  ENOSPC: "disk-full",
};

// Turn an error into a coded response: user errors -> 4xx, everything else -> 500.
function errorResponse(e: unknown): Response {
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
  const session = opts.session ?? new Session(new NodeStorage(), undefined, hostPlatform(process.platform));
  const pick = opts.pick ?? pickFile;
  const pickSave = opts.pickSave ?? pickSaveFile;

  const state = (): StateResponse => ({ open: session.open, version: opts.version });

  // Used at startup when a folder (and locale) is given on the command line.
  async function openPath(path: string, locale: string): Promise<Response> {
    try {
      await session.openFolder(path, locale);
      return json(state());
    } catch (e) {
      return errorResponse(e);
    }
  }

  type Handler = (body: Record<string, unknown>) => unknown;

  const langOf = (b: Record<string, unknown>): Lang => (isLang(b.lang) ? b.lang : "en");
  const pathOf = (b: Record<string, unknown>) => {
    const p = str(b.path).trim();
    if (!p) throw new AppError("missing-path", "Missing folder path.");
    return p;
  };
  const keysOf = (v: unknown): KeyRef[] => (Array.isArray(v) ? (v as KeyRef[]) : []);
  // Dialogs start next to the open folder (usually MuMain/src): TSV exchange files do not belong
  // inside the Localization folder, where they would end up in git.
  const startDir = () => (session.open ? pathDirname(session.open.folder.path) : undefined);
  const PICK_KINDS: PickKind[] = ["folder", "tsv", "glossary"];

  const posts: Record<string, Handler> = {
    "/api/scan": (b) => session.scan(pathOf(b)),
    "/api/open": async (b) => {
      await session.openFolder(pathOf(b), str(b.locale).trim(), str(b.reference).trim() || null, {
        discard: b.discard === true,
        create: b.create === true,
        name: typeof b.name === "string" ? b.name : undefined,
      });
      return state();
    },
    "/api/edit": (b) => {
      if (b.value !== null && typeof b.value !== "string") return fail(400, "bad-json", "Invalid value.");
      return session.edit(str(b.group), str(b.key), b.value, str(b.translator));
    },
    "/api/keep": (b) => session.setKeep(str(b.group), str(b.key), b.keep === true, str(b.translator)),
    "/api/revert": (b) => session.revert(str(b.group), str(b.key)),
    "/api/undo": () => session.undo(),
    "/api/redo": () => session.redo(),
    "/api/save": async (b): Promise<SaveResponse> => ({ ...(await session.save({ force: b.force === true })), status: session.status() }),
    "/api/rebase": () => session.rebase(),
    "/api/draft/restore": () => session.restoreDraft(),
    "/api/draft/discard": async () => {
      await session.discardDraft();
      return { ok: true };
    },
    "/api/reference": async (b) => {
      if (!session.open) throw new NoFolderError();
      await session.setReference(str(b.locale).trim() || null);
      return state();
    },
    "/api/pick": async (b) => {
      const kind = PICK_KINDS.includes(b.kind as PickKind) ? (b.kind as PickKind) : "folder";
      return { path: await pick(langOf(b), kind, startDir()) } satisfies PickResponse;
    },
    "/api/pick-save": async (b) => {
      const kind: SaveKind = b.kind === "glossary" || b.kind === "zip" ? b.kind : "tsv";
      const name = str(b.defaultName).replace(/[\\/:*?"<>|]/g, "_").trim() || { tsv: "translations.tsv", glossary: "Glossary.tsv", zip: "translations.zip" }[kind];
      const dir = startDir() ?? process.cwd();
      return { path: await pickSave(pathJoin(dir, name), langOf(b), kind) } satisfies PickResponse;
    },
    "/api/status": (b) => {
      if (!isStatus(b.status)) return fail(400, "bad-json", "Invalid status.");
      return session.setStatus(keysOf(b.keys), b.status, str(b.translator));
    },
    "/api/note": (b) => session.setNote(str(b.group), str(b.key), str(b.note), str(b.translator)),
    "/api/export": (b) => session.exportTsv(pathOf(b), keysOf(b.keys)),
    "/api/import/preview": (b) => session.previewImport(pathOf(b)),
    "/api/package/export": (b) =>
      session.exportPackage(pathOf(b), { glossary: str(b.glossary).trim() || null, translator: str(b.translator), tool: opts.version }),
    "/api/sheets/export": (b) => session.exportSheets(pathOf(b)),
    "/api/package/glossary": async (b) => ({ path: await session.importPackageGlossary(pathOf(b), str(b.token)) }),
    "/api/import/apply": (b) => session.applyImport(pathOf(b), str(b.token), keysOf(b.take), str(b.translator)),
    // The glossary is a standalone file shared by the team (and with MuBMD-editor).
    "/api/glossary/load": (b): Promise<GlossaryInfo> => loadGlossaryFile(session.storage, pathOf(b)),
    // Proposals of an AI assistant / a script (.mumain-translator/proposals/).
    "/api/proposals/decide": (b) => session.decideProposals(Array.isArray(b.decisions) ? (b.decisions as ProposalDecision[]) : [], str(b.translator)),
    "/api/glossary/save": (b): Promise<GlossaryInfo> => saveGlossaryFile(session.storage, pathOf(b), Array.isArray(b.entries) ? b.entries : []),
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
      if (pathname === "/api/registration") {
        try {
          return json(await session.registration());
        } catch (e) {
          return errorResponse(e);
        }
      }
      if (pathname === "/api/proposals") {
        try {
          return json(await session.proposals());
        } catch (e) {
          return errorResponse(e);
        }
      }
      if (pathname === "/api/rows") {
        try {
          return json(session.rows());
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
