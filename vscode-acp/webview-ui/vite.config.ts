// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the AiNxt chat UI to a predictable single JS+CSS the extension loads
// into the webview via asWebviewUri.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
