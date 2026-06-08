import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  // IMPORTANT: disable Vite's static dir so it does NOT serve the old ui/public frontend
  publicDir: false,
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "esnext" },
});
