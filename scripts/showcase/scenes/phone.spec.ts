import * as path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { launchShowcaseApp, sendChatMessage, taskColumn } from '../electron-app';

const OUTPUT = path.join(import.meta.dirname, '..', '..', '..', '.tmp', 'showcase', 'phone.png');

// A dev Parallel Code on the default 8777 must not collide with the showcase.
const PORT = 18777;

type RemoteServer = { url: string };

type IpcWindow = {
  electron: { ipcRenderer: { invoke: (channel: string, args: unknown) => Promise<unknown> } };
};

// Electron crashes opening a second window under headless ozone, so the phone
// UI renders in Playwright's own Chromium, as a phone would load it.
test('phone: every task and what needs you, from your phone', async () => {
  const { page, close } = await launchShowcaseApp({ withTasks: true });
  const browser = await chromium.launch();
  try {
    await expect(taskColumn(page, 'sydney-dates').getByText('Approval needed')).toBeVisible();
    await sendChatMessage(page, 'five-day-forecast', 'Also show min/max temperature per day.');
    const server = await page.evaluate(
      (port) =>
        (window as unknown as IpcWindow).electron.ipcRenderer.invoke('start_remote_server', {
          port,
        }) as Promise<RemoteServer>,
      PORT,
    );
    // Opening Connect Phone adopts the running server, which starts the task
    // status sync; without it the phone shows every task as idle.
    await page.getByRole('button', { name: 'Connect phone' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The URL names a LAN address; the page is the same on loopback.
    const url = new URL(server.url);
    url.hostname = '127.0.0.1';

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
    });
    const phone = await context.newPage();
    await phone.goto(url.href);
    await phone.getByRole('button', { name: 'Continue viewing only' }).click();
    await expect(phone.getByText('Your tasks')).toBeVisible();
    // The committed task turns ready on the second git poll, about 30 s in.
    await expect(phone.getByText('Ready to review')).toBeVisible({ timeout: 45_000 });
    await phone.waitForTimeout(1000);
    await phone.screenshot({ path: OUTPUT });
  } finally {
    await browser.close();
    await close();
  }
});
