import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "website/test/**/*.test.ts"],
    testTimeout: 15000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
