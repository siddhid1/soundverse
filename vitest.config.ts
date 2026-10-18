import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Existing suites isolate billing mechanics against a clean ledger, so
    // signup grants are off by default in tests. The dedicated bonus suite
    // (tests/phase7-bonus.test.ts) overrides this in its own fork.
    env: { SIGNUP_BONUS_CREDITS: "0" },
  },
});
