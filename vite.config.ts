// vite.config.ts - Giao diện Vue (web/). Dev: `bun run dev` (Vite 5173 + proxy /api -> server 4817).
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
    // Biên dịch sẵn file ngôn ngữ lúc build -> dùng bản runtime-only của vue-i18n.
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
    proxy: { "/api": "http://127.0.0.1:4817" },
  },
  build: {
    outDir: r("./build/web-dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
