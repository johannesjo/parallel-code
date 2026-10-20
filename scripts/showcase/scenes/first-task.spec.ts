import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchShowcaseApp, recordScene } from '../electron-app';
import { createCamera, createPointer, installCursor, nextScene, typeText } from '../video-kit';

const OUTPUT = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.tmp',
  'showcase',
  'first-task.mp4',
);

// Editorial pacing, not readiness: assertions below wait for the UI.
const hold = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('first task: create a task and watch its agent start', async () => {
  const { page, close } = await launchShowcaseApp();
  try {
    // The cursor installs through an init script, which needs a fresh load.
    await installCursor(page);
    await page.reload();
    const newTask = page.getByRole('button', { name: 'New Task' });
    await expect(newTask).toBeVisible();

    await recordScene(page, OUTPUT, async () => {
      const pointer = createPointer(page);
      const camera = createCamera(page, '#root');

      const caption = await nextScene(page, {
        caption: 'One task, one worktree.',
        pointer,
        camera,
      });
      await pointer.glideTo(newTask);
      await newTask.click();

      const prompt = page.getByPlaceholder('What should the agent work on?');
      await expect(prompt).toBeVisible();
      await pointer.glideTo(prompt);
      await prompt.click();
      await typeText(page, 'Add a 5-day forecast view');

      const create = page.getByRole('button', { name: 'Create Task' });
      await pointer.glideTo(create);
      await create.click();

      const terminal = page.locator('.xterm').first();
      await expect(terminal.locator('.xterm-rows')).toContainText('demo ready');
      await caption?.hide();
      await hold(600);
      // The terminal is mostly empty rows; frame the task title and the rows
      // the agent writes during the hold, not the terminal's middle.
      await camera.zoomTo(
        [page.locator('.task-title-bar').first(), terminal.locator('.xterm-rows > div').nth(6)],
        { scale: 1.6 },
      );
      await hold(2500);
      await camera.reset();
      await hold(800);
    });
  } finally {
    await close();
  }
});
