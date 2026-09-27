import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works under GitHub Pages' /<repo>/ prefix.
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        corsProbe: resolve(import.meta.dirname, "scripts/cors-probe.html"),
      },
    },
  },
});
