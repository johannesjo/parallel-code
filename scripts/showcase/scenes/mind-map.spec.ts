import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { PLAN_MAP_LIVE_UPDATE } from '../canvases';
import {
  clearCanvasSelection,
  launchShowcaseApp,
  publishAsAgent,
  sendChatMessage,
} from '../electron-app';

const OUTPUT = path.join(import.meta.dirname, '..', '..', '..', '.tmp', 'showcase', 'mind-map.png');

test('mind map: a plan whose branches are running tasks', async () => {
  const { app, page, close } = await launchShowcaseApp({
    withTasks: true,
    planner: true,
    focus: 'plan-v2',
  });
  try {
    // The task restores with its mind map tab open.
    const map = page.getByLabel('Mind map editor');
    await expect(map).toBeVisible();
    // Linked branches show their task's live state; the committed task turns
    // ready on the second git poll, about 30 s in.
    await expect(map.getByText('Needs input')).toBeVisible();
    await expect(map.getByText('Ready to merge')).toBeVisible({ timeout: 45_000 });
    // The planner answers by adding steps to the map, as its MCP call would.
    await sendChatMessage(page, 'plan-v2', 'Break the 5-day forecast into steps.');
    await publishAsAgent(app, {
      canvas: 'mindmap',
      taskId: 'task-plan-v2',
      data: PLAN_MAP_LIVE_UPDATE,
    });
    await clearCanvasSelection(page, map);
    await expect(map.getByText('Rain icon')).toBeVisible();
    // New nodes pulse for about 3 s after they arrive.
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUTPUT });
  } finally {
    await close();
  }
});
