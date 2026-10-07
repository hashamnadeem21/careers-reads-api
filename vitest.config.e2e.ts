import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: "./",
    include: ["test/**/*.e2e-spec.ts"],
    // All e2e files share the blognest_test database, so they run one at a time.
    fileParallelism: false,
  },
});
