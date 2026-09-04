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
      // A floor, not a target: ~3 points under the measured totals (58/56/45/54
      // at the time of writing) so CI fails when a change drops coverage
      // noticeably, without failing on noise. Raise these as coverage grows.
      thresholds: {
        lines: 55,
        statements: 53,
        functions: 42,
        branches: 50,
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
