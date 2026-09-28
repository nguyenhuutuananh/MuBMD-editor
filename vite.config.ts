// vite.config.ts - Vue UI (web/). Dev: `bun run dev` = Vite on 5173 (HMR) + the Bun API server
// on 4817; /api is proxied to it, so dev runs the API on the same runtime (Bun) as releases.
import { fileURLToPath } from "node:url";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./web"),
  plugins: [
    vue(),
    tailwindcss(),
    // Precompile locale files at build time -> runtime-only vue-i18n build.
    VueI18nPlugin({ include: [r("./web/src/i18n/locales/**")], compositionOnly: true, fullInstall: false }),
  ],
  resolve: {
    alias: {
      "@": r("./web/src"),
      "@core": r("./src/core"),
      "@shared": r("./src/shared"),
    },
  },
  server: {
    port: 5173,
    // The API server's Host check accepts localhost:5173, so the Host header is passed through unchanged.
    proxy: { "/api": "http://127.0.0.1:4817" },
  },
  build: {
    outDir: r("./build/web-dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
