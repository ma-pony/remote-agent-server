import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readEnvironmentFile } from "./src/environment-file.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(() => {
  const environment = readEnvironmentFile(resolve(projectRoot, ".env"), process.env);
  const apiTarget = `http://127.0.0.1:${environment.PORT?.trim() || "3000"}`;
  return {
    root: resolve(projectRoot, "src/web"),
    envDir: projectRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": resolve(projectRoot, "src/web") }
    },
    build: {
      outDir: resolve(projectRoot, "dist/web"),
      emptyOutDir: true
    },
    server: {
      proxy: { "/api": apiTarget, "/integration": apiTarget }
    }
  };
});
