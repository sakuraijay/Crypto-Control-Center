import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

function resolvePort(command: 'build' | 'serve'): number {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    if (command === 'build') {
      // 프로덕션 빌드에서는 dev 서버가 실행되지 않으므로
      // 설정 평가용 기본값만 제공한다.
      return 5173;
    }
    throw new Error(
      'PORT environment variable is required but was not provided.',
    );
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  return port;
}

function resolveBasePath(command: 'build' | 'serve'): string {
  const basePath = process.env.BASE_PATH;

  if (!basePath) {
    if (command === 'build') {
      return '/';
    }
    throw new Error(
      'BASE_PATH environment variable is required but was not provided.',
    );
  }

  return basePath;
}

export default defineConfig(async ({ command }) => {
  const port = resolvePort(command);
  const basePath = resolveBasePath(command);

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Note: Vite proxy does NOT work in Replit's path-based routing environment.
    // All API calls go via /api-server/api/* (Express proxy) — GMX prices, markets, candles, VPS.
    proxy: {},
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  };
});
