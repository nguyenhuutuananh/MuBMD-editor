// vite.config.ts - Vue UI (web/), two targets chosen by VITE_TARGET:
//   desktop (default)  `bun run dev` = Vite on 5173 (HMR) + the Bun API server on 4817 (/api proxied),
//                      so dev runs the API on the same runtime (Bun) as releases.
//   web                `bun run dev:web` = Vite only; the Session runs in the browser (localBackend.ts).
//                      `bun run build:web-static` -> build/web-static/: a static, relative-path PWA
//                      (GitHub Pages or any static host, any sub-path).
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { pwa } from "./scripts/vite-pwa";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const target = process.env.VITE_TARGET === "web" ? "web" : "desktop";
const pkg = JSON.parse(fs.readFileSync(r("./package.json"), "utf-8")) as { version: string };

export default defineConfig({
  root: r("./web"),
  plugins: [
    vue(),
    tailwindcss(),
    // Precompile locale files at build time -> runtime-only vue-i18n build.
    VueI18nPlugin({ include: [r("./web/src/i18n/locales/**")], compositionOnly: true, fullInstall: false }),
    ...(target === "web" ? [pwa({ publicDir: r("./web/public"), version: pkg.version })] : []),
  ],
  // Web: relative URLs so the static site works under any path; desktop: served from "/".
  base: target === "web" ? "./" : "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@backend": r(target === "web" ? "./web/src/lib/localBackend.ts" : "./web/src/lib/httpBackend.ts"),
      "@": r("./web/src"),
      "@core": r("./src/core"),
      "@shared": r("./src/shared"),
    },
  },
  server: {
    port: target === "web" ? 5174 : 5173,
    // The API server's Host check accepts localhost:5173, so the Host header is passed through unchanged.
    proxy: { "/api": "http://127.0.0.1:4817" },
  },
  build: {
    outDir: r(target === "web" ? "./build/web-static" : "./build/web-dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
