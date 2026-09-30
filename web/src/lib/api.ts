// api.ts - The backend used by the UI. "@backend" is resolved at build time by vite.config.ts.

import { backend } from "@backend";

export { ApiError, type Backend, type ClientErrorCode } from "./backend";
export const api = backend;
export const isWeb = backend.kind === "local";
// Web build in a browser without the File System Access API (Firefox, Safari, or "?fallback"): the
// folder's files are uploaded into the browser and saving downloads the result.
export const isFallback = backend.fallback === true;
