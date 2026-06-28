import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/quota-engine/test/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",
  },
});
