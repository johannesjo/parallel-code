import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchShowcaseApp, sendChatMessage, taskColumn } from '../electron-app';

const OUTPUT = path.join(import.meta.dirname, '..', '..', '..', '.tmp', 'showcase', 'focus.png');

test('focus: one task with its agent, shell and notes', async () => {
  const { page, close } = await launchShowcaseApp({
    withTasks: true,
    focus: 'five-day-forecast',
    shell: true,
  });
  try {
    await sendChatMessage(page, 'five-day-forecast', 'Also show min/max temperature per day.');
    await expect(taskColumn(page, 'five-day-forecast')).toContainText('Adding min/max');
    // Real output from the task's worktree, so the shell reads as in use.
    const shell = page.locator('.xterm').filter({ hasText: 'five-day-forecast $' });
    await shell.click();
    await page.keyboard.type('git status --short\n');
    await expect(shell).toContainText('src/components/');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
