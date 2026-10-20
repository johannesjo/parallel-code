import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchShowcaseApp } from '../electron-app';

const OUTPUT = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.tmp',
  'showcase',
  'real-agent.png',
);

// Spends Claude plan usage (Haiku), so it only runs when asked for.
test.skip(
  !process.env.SHOWCASE_REAL_AGENTS,
  'set SHOWCASE_REAL_AGENTS=1 to run a real, pinned agent',
);

test('real agent: Claude Code answers on Haiku', async () => {
  const { page, close } = await launchShowcaseApp({ realAgents: ['claude'] });
  try {
    await page.getByRole('button', { name: 'New Task' }).click();
    await page.getByRole('radio', { name: /Claude Code/ }).click();
    await page.getByPlaceholder('What should the agent work on?').fill('Add a 5-day forecast view');
    await page.getByRole('button', { name: 'Create Task' }).click();

    // Check the process that actually runs, not the arguments the app intended.
    await expect
      .poll(() => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }), { timeout: 30_000 })
      .toMatch(/^\S*claude --model haiku\b/m);

    // Haiku asking to edit a file shows it got the prompt and worked on it.
    const terminal = page.locator('.xterm-rows').first();
    await expect(terminal).toContainText(/Do you want/, { timeout: 120_000 });
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
