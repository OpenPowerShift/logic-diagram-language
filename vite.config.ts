import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@ldl': '/src',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
    exclude: ['tests/visual/**/*.spec.ts'],
  },
});