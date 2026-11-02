import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchShowcaseApp, sendChatMessage } from '../electron-app';

const OUTPUT = path.join(import.meta.dirname, '..', '..', '..', '.tmp', 'showcase', 'board.png');

test('board: ten agents across every lane', async () => {
  const { page, close } = await launchShowcaseApp({ board: true });
  try {
    const card = (name: string) => page.locator('.task-board-card', { hasText: name });
    await card('Add a 5-day forecast view').getByRole('button').first().click();
    await sendChatMessage(page, 'five-day-forecast', 'Also show min/max temperature per day.');
    await expect(card('Add a 5-day forecast view')).toHaveClass(/state-active/);
    await expect(card('Fix dates a day off in Sydney')).toHaveClass(/state-needs_input/);
    await expect(card('Add a °C/°F toggle')).toHaveClass(/state-needs_input/);
    // The first git poll skips tasks that just printed output; the next one,
    // 30 s later, marks the committed tasks ready.
    for (const name of ['Document local setup', 'Rain alerts at 8 am']) {
      await expect(card(name)).toHaveClass(/state-ready/, { timeout: 45_000 });
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
