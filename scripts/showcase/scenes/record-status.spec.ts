import { expect, test, type Page } from '@playwright/test';
import { launchShowcaseApp } from '../electron-app';

// Spends Claude plan usage (Haiku) and ChatGPT plan usage (the cheapest Codex
// model). Records real sessions for the status replay tests: permission
// questions, approvals, finished turns, interrupts and a question. See
// electron/agent-hooks/sessions/README.md.
test.skip(
  !process.env.SHOWCASE_REAL_AGENTS || !process.env.PARALLEL_CODE_RECORD_SESSIONS,
  'set SHOWCASE_REAL_AGENTS=1 and PARALLEL_CODE_RECORD_SESSIONS=<absolute dir> to record',
);

/**
 * Waits for `next` on the agent's screen. Claude Code may first offer auto
 * mode, which never asks permission; choose "No, keep manual mode".
 */
const declineAutoMode = async (page: Page, next: RegExp): Promise<void> => {
  const terminal = page.locator('.xterm-rows').first();
  const input = page.locator('.xterm-helper-textarea').first();
  await expect(terminal).toContainText(new RegExp(`Make auto mode|${next.source}`), {
    timeout: 120_000,
  });
  if (!/Make auto mode/.test((await terminal.textContent()) ?? '')) return;
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(terminal).toContainText(next, { timeout: 120_000 });
};

test('record status: Claude Code approval, finish and interrupt', async () => {
  test.setTimeout(300_000);
  const { page, close } = await launchShowcaseApp({ realAgents: ['claude'] });
  try {
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    await page.getByRole('radio', { name: /Claude Code/ }).click();
    await page
      .getByPlaceholder('What should the agent work on?')
      .fill('Create a file NOTES.md containing the single line "hello". Do nothing else.');
    await page.getByRole('button', { name: 'Create Task' }).click();

    const terminal = page.locator('.xterm-rows').first();
    const input = page.locator('.xterm-helper-textarea').first();
    await declineAutoMode(page, /Do you want/);
    await input.press('Enter');
    await expect(terminal).not.toContainText(/Do you want/, { timeout: 30_000 });
    await page.waitForTimeout(15_000);

    // A long command, so the Escape lands while it runs: Claude Code reports no
    // Stop hook for an interrupt.
    await input.pressSequentially(
      'Run this in the foreground, not in the background: `for i in $(seq 1 30); do echo $i; sleep 1; done`',
    );
    await input.press('Enter');
    await expect(terminal).toContainText(/Do you want/, { timeout: 60_000 });
    await input.press('Enter');
    await page.waitForTimeout(5_000);
    await input.press('Escape');
    await page.waitForTimeout(5_000);
  } finally {
    await close();
  }
});

test('record status: Claude Code asks a question', async () => {
  test.setTimeout(300_000);
  const { page, close } = await launchShowcaseApp({ realAgents: ['claude'] });
  try {
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    await page.getByRole('radio', { name: /Claude Code/ }).click();
    await page
      .getByPlaceholder('What should the agent work on?')
      .fill(
        'Use your AskUserQuestion tool to ask me one question: should the greeting be "hi" or "hello"? Then reply with my answer and do nothing else.',
      );
    await page.getByRole('button', { name: 'Create Task' }).click();

    const input = page.locator('.xterm-helper-textarea').first();
    await declineAutoMode(page, /Enter to select/);
    await page.waitForTimeout(3_000);
    await input.press('Enter');
    await page.waitForTimeout(15_000);
  } finally {
    await close();
  }
});

// Spends ChatGPT plan usage (the cheapest Codex model). The wrapper refuses
// `codex app-server`, which the hook probe needs, so this records the screen
// and keys alone; the hook-only Codex sessions cover its hooks.
test('record status: Codex approval, finish and interrupt', async () => {
  test.setTimeout(300_000);
  const { page, close } = await launchShowcaseApp({ realAgents: ['codex'] });
  try {
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    await page.getByRole('radio', { name: /Codex/ }).click();
    await page
      .getByPlaceholder('What should the agent work on?')
      .fill(
        'Run the shell command `touch ../outside-notes.md` with escalated permissions (ask me to approve it) and do nothing else.',
      );
    await page.getByRole('button', { name: 'Create Task' }).click();

    const terminal = page.locator('.xterm-rows').first();
    const input = page.locator('.xterm-helper-textarea').first();
    // Writing outside the worktree is the one thing Codex asks permission for.
    await expect(terminal).toContainText(/Would you like to/, { timeout: 120_000 });
    await page.waitForTimeout(3_000);
    await input.press('Enter');
    await expect(terminal).not.toContainText(/Would you like to/, { timeout: 30_000 });
    await page.waitForTimeout(20_000);

    await input.pressSequentially(
      'Run `for i in $(seq 1 30); do echo $i; sleep 1; done` in the worktree and wait for it.',
    );
    // Codex reads fast typing as a paste, where Enter only adds a line.
    await page.waitForTimeout(1_000);
    await input.press('Enter');
    await page.waitForTimeout(10_000);
    await input.press('Escape');
    await page.waitForTimeout(5_000);
  } finally {
    await close();
  }
});
