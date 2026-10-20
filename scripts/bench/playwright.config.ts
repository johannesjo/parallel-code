import { defineConfig } from '@playwright/test';
import path from 'node:path';

/**
 * Performance benchmarks against the built app, reusing the showcase harness.
 * Run as described in chat-stream.spec.ts; results land in `.tmp/bench/`.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  // One app at a time: parallel runs would compete for the same CPU.
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: path.join(import.meta.dirname, '..', '..', '.tmp', 'bench', '_results'),
  timeout: 600_000,
  expect: { timeout: 60_000 },
});
