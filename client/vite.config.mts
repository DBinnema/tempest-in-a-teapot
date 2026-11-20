import { defineConfig } from "vite";

// base "./" keeps every asset URL relative, which is what Discord's
// /.proxy/ path prefix needs. envDir points at the repo root so one .env
// file serves both the server and the client build.
export default defineConfig({
  root: __dirname,
  base: "./",
  envDir: "..",
  server: { port: 5173, fs: { allow: [".."] } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2500, target: "es2020" },
});
