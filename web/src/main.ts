import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { isWeb } from "./lib/api";
import { registerServiceWorker } from "./lib/pwa";
import "./style.css";

createApp(App).use(createPinia()).use(i18n).mount("#app");

// Web build in production: installable / offline (the desktop build is served by the local server).
if (import.meta.env.PROD && isWeb) registerServiceWorker();
