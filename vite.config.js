import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("fabric")) {
            return "fabric";
          }
          if (id.includes("pdfjs-dist")) {
            return "pdfjs";
          }
          if (id.includes("pdf-lib")) {
            return "pdflib";
          }
        },
      },
    },
  },
});
