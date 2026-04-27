import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,       // run test files sequentially (shared server for integration)
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Coverage is measured against the built dist output (what tests actually exercise).
      // The generated SCXML modules and runtime are excluded — they are produced by the
      // scxml-gen tool and their behavior is verified by the integration tests.
      include: [
        "dist/twin/**/*.js",
        "dist/services/**/*.js",
        "dist/api/**/*.js",
        "dist/headless/**/*.js",
      ],
      exclude: [
        "dist/state-machines/**",
        "dist/renderer/**",
        "dist/main/**",
        "**/*.test.js",
      ],
      // Phase 0 baseline thresholds. Rise to 55% after Phase 1, 70% after Phase 3.
      thresholds: {
        lines: 40,
        statements: 40,
        functions: 40,
        branches: 35,
      },
      reportsDirectory: "coverage",
    },
  },
});
