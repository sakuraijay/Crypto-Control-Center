import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals:     true,
    include:     ['src/__tests__/**/*.test.ts'],
    // Use a single fork so module-level mocks don't bleed between files
    poolOptions: { forks: { singleFork: false } },
  },
});
