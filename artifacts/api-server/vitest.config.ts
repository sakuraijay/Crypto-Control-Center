import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals:     true,
    include:     ['src/__tests__/**/*.test.ts'],
    // Managed validation runs typecheck, review, and package suites concurrently.
    // Keep import-heavy safety tests bounded, but allow for temporary CPU contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Use a single fork so module-level mocks don't bleed between files
    poolOptions: { forks: { singleFork: false } },
  },
});
