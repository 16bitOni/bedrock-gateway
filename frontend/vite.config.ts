import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:8787";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          charts: ["recharts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: backend, changeOrigin: true },
      "/api": { target: backend, changeOrigin: true },
      "/files": { target: backend, changeOrigin: true },
      "/anthropic": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
