// Bundled fonts (offline-safe — Vite inlines the woff2 into ui/dist).
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/design/tokens.css";
import { themeStore } from "./lib/stores/theme.svelte.js";

// Apply the persisted theme to <html> BEFORE the first paint (no flash).
themeStore.init();

const app = mount(App, { target: document.getElementById("app")! });

export default app;
