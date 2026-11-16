// Bundled fonts (offline-safe — Vite inlines the woff2 into ui/dist).
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import "./lib/design/tokens.css";
import { initPersistence } from "./lib/persist/store.js";

// Hydrate persisted settings BEFORE importing any store (whose synchronous
// construction reads settings) or mounting the app. Dynamic imports run after
// the await, so every read hits the hydrated snapshot — and the persisted
// theme is applied before first paint, avoiding a flash.
// WebKitGTK runs with compositing disabled here (NVIDIA + XWayland cannot display it), and
// in that mode a CSS transition that runs during startup leaves the whole window unpainted
// until a manual resize. Keyframe animations are unaffected. Measured 2026-11-16: black on
// every launch with transitions, painted on every launch without.
if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
  document.documentElement.classList.add("no-transitions");
}

async function bootstrap(): Promise<void> {
  await initPersistence();

  const { themeStore } = await import("./lib/stores/theme.svelte.js");
  themeStore.init();

  const { mount } = await import("svelte");
  const { default: App } = await import("./App.svelte");
  mount(App, { target: document.getElementById("app")! });
}

void bootstrap();
