import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin({ ssr: true })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // A floor, not a target: a few points under the measured totals so CI
      // fails when a change drops coverage noticeably, without failing on
      // noise. Raise these as coverage grows.
      thresholds: {
        lines: 58,
        statements: 56,
        functions: 44,
        branches: 52,
      },
      exclude: [
        'coverage/**',
        'dist/**',
        'dist-electron/**',
        'dist-remote/**',
        'build/**',
        '**/*.test.ts',
      ],
    },
  },
});
