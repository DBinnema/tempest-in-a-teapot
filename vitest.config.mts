import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    // the e2e test binds a port; keep files sequential for clean logs
    fileParallelism: false,
  },
});
