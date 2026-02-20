import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "path";

export default defineConfig({
  base: "./",
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "shims/tauri-api-core.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "shims/tauri-api-window.ts"),
      "@tauri-apps/api/dpi": path.resolve(__dirname, "shims/tauri-api-dpi.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "shims/tauri-plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "shims/tauri-plugin-opener.ts"),
    },
  },
});
