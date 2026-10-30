import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  // No HMR in tests: solid-refresh wraps components and renames them to
  // `[solid-refresh]<Name>`, so tests would see different functions than the app.
  plugins: [solidPlugin({ ssr: false, hot: false })],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.client.test.tsx'],
  },
});
