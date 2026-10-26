import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the UI runs on :5173 and proxies the API (secrets stay in the Node server).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true },
});
