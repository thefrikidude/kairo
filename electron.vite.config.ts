import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const desktopRoot = resolve("src/interface/desktop");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "main/index.ts"),
          backend: resolve(desktopRoot, "backend/protocol.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(desktopRoot, "renderer"),
    plugins: [react()],
    build: {
      minify: "esbuild",
      rollupOptions: { input: resolve(desktopRoot, "renderer/index.html") },
    },
  },
});
