import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors the `@/*` path mapping in tsconfig.json, which the Nest build
  // rewrites for dist but Vitest does not resolve on its own.
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
  esbuild: {
    target: 'node20',
  },
});
