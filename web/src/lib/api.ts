// api.ts - The backend used by the UI (desktop: HTTP to the local server; web: in-browser Session).
// "@backend" is resolved at build time by vite.config.ts from VITE_TARGET.

import { backend } from "@backend";

export { ApiError, type Backend, type ClientErrorCode } from "./backend";
export const api = backend;
export const isWeb = backend.kind === "local";
export const isFallback = backend.fallback === true;
