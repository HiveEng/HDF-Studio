import { defineConfig } from "vite";

// Tauri expects a fixed port and no clearing of its console output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "esnext" },          // mupdf.js uses top-level await
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] }, // keep the .wasm next to its loader
});
