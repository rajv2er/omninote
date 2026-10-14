import { defineConfig } from "vite";

export default defineConfig({
  define: {
    // Baked-in app version for the library footer / update checks. The web
    // build has no Tauri runtime, so the version cannot be read live there.
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "0.0.0"),
  },
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
