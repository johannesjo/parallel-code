import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchShowcaseApp, sendChatMessage, taskColumn } from '../electron-app';

const OUTPUT = path.join(import.meta.dirname, '..', '..', '..', '.tmp', 'showcase', 'overview.png');

test('overview: agents working, waiting and ready to merge', async () => {
  const { page, close } = await launchShowcaseApp({ withTasks: true });
  try {
    await expect(taskColumn(page, 'sydney-dates').getByText('Approval needed')).toBeVisible();
    await expect(taskColumn(page, 'readme-setup')).toContainText('The README covers install');
    await sendChatMessage(page, 'five-day-forecast', 'Also show min/max temperature per day.');
    await expect(taskColumn(page, 'five-day-forecast')).toContainText('Adding min/max');
    // The first git poll skips tasks that just printed output; the next one,
    // 30 s later, marks the committed task ready.
    await expect(page.getByText('Ready to merge')).toBeVisible({ timeout: 45_000 });
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
