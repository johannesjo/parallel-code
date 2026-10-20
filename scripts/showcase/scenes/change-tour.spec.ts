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
  'change-tour.png',
);

test('change tour: a guided walk through what the agent changed', async () => {
  const { page, close } = await launchShowcaseApp({ withTasks: true, focus: 'five-day-forecast' });
  try {
    await page.getByRole('button', { name: /Generate tour/ }).click();
    await page.getByRole('button', { name: /Start tour/ }).click();
    const tour = page.getByRole('region', { name: 'Guided change tour' });
    await expect(tour).toBeVisible();
    // The stop that flags something to check shows the tour's value best.
    for (let i = 0; i < 3; i++) await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour.getByText('Days are labelled')).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
