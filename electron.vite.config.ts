import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") }, external: ["ws", "electron"] },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: { outDir: "out/renderer", rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
  },
});
