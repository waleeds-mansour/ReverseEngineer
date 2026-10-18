import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

// Nook's pages carry a strict Content-Security-Policy. Vite's dev server injects inline scripts
// and a websocket for hot reload, which that policy would block, so the tag is dropped while
// developing only; built pages keep it.
const devWithoutNookCsp = (): Plugin => ({
  name: "nook-dev-without-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, ""),
});

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), devWithoutNookCsp()],

  // Path aliases
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/bindings": resolve(__dirname, "./src/bindings.ts"),
    },
  },

  // Multiple entry points for main app and overlay
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
        nook_panel: resolve(__dirname, "src/nook/panel.html"),
        nook_bar: resolve(__dirname, "src/nook/bar.html"),
        nook_popover: resolve(__dirname, "src/nook/popover.html"),
        // src/nook/preview/ is for the dev server only and is never built.
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
