import { defineConfig } from "vitest/config";

// Only croak's own tests. Eval fixtures are untrusted repos that may ship
// their own test files; the test runner must never import or execute them.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
