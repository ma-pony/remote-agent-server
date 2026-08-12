import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, "src/web"),
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, "dist/web"),
    emptyOutDir: true
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:3000" }
  }
});
