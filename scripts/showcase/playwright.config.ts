import { defineConfig } from '@playwright/test';
import path from 'node:path';

/**
 * Scripted showcase recordings of the built app. One spec = one recording in
 * `.tmp/showcase/`. Run with `npm run showcase:capture`.
 */
export default defineConfig({
  testDir: path.join(import.meta.dirname, 'scenes'),
  // One app at a time: recordings are timing-sensitive.
  workers: 1,
  // Failed recordings need a look, not a retry.
  retries: 0,
  reporter: 'line',
  // Trace screenshots would claim the page's screencast before the recorder does.
  use: { trace: { mode: 'retain-on-failure', screenshots: false } },
  outputDir: path.join(import.meta.dirname, '..', '..', '.tmp', 'showcase', '_results'),
  timeout: 180_000,
  expect: { timeout: 20_000 },
});
