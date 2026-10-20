import * as path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchShowcaseApp } from '../electron-app';

const OUTPUT = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.tmp',
  'showcase',
  'diff-review.png',
);

/**
 * Selects the code of the added line containing `text`, as a mouse drag
 * would, which opens the inline comment input.
 */
const selectDiffLine = async (page: Page, file: string, text: string): Promise<void> => {
  const line = page.locator(`[data-file-path="${file}"][data-line-type="add"]`, { hasText: text });
  const code = line.locator(':scope > span').nth(3);
  // Highlighting replaces the line's DOM once it arrives, dropping a selection made before it.
  await expect(code.locator('span').first()).toBeAttached();
  await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
};

test('diff review: comment on the agent’s change before merging', async () => {
  const { page, close } = await launchShowcaseApp({ withTasks: true, focus: 'five-day-forecast' });
  try {
    await page.locator('.file-row', { hasText: 'forecast.ts' }).click();
    await selectDiffLine(page, 'src/forecast.ts', 'label:');
    const comment = page.getByPlaceholder('Add review comment...');
    await comment.fill('Label days by weekday (Mon, Tue…), not "Day 1".');
    await comment.press('Enter');
    await expect(page.getByText('Label days by weekday').first()).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
