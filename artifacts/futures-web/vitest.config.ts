import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' }, // 6E-10 — tsx 테스트(runtime 렌더)용 자동 JSX 런타임
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node', // pure functions only — no DOM needed
    globals:     true,
    include:     ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    exclude:     ['**/node_modules/**', '**/dist/**', '**/build/**'],
  },
});
