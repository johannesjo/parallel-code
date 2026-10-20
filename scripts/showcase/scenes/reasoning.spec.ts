import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { DATES_REASONING } from '../canvases';
import {
  clearCanvasSelection,
  launchShowcaseApp,
  publishAsAgent,
  taskColumn,
} from '../electron-app';

const OUTPUT = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.tmp',
  'showcase',
  'reasoning.png',
);

test('reasoning graph: how the agent found the date bug', async () => {
  const { app, page, close } = await launchShowcaseApp({ withTasks: true, focus: 'sydney-dates' });
  try {
    await expect(taskColumn(page, 'sydney-dates').getByText('Approval needed')).toBeVisible();
    // The agent's first update opens the reasoning canvas. One sent before the
    // renderer tracks the agent is dropped; resending is safe, as the app
    // accepts an identical update once.
    const node = page.getByLabel('Reasoning graph').getByText('toISOString() converts to UTC');
    await expect(async () => {
      await publishAsAgent(app, {
        canvas: 'reasoning',
        taskId: 'task-sydney-dates',
        data: DATES_REASONING,
      });
      await expect(node).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await clearCanvasSelection(page, page.getByLabel('Reasoning graph'));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
