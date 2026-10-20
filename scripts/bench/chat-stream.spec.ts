/**
 * How chat view's cost grows with the conversation. For each history size it
 * resumes a scripted chat of that many items, streams one long reply into it,
 * then scrolls the transcript from bottom to top, measuring the renderer
 * (Chrome DevTools Performance metrics, frame intervals) and the main process
 * (CPU time). Each size runs with and without `content-visibility: auto` on
 * transcript entries, the cheapest candidate fix.
 *
 * Sizes: BENCH_SIZES=100,1000,3000 (default); BENCH_TRACE=1 adds a trace
 * breakdown and BENCH_PROFILE=1 a JavaScript profile. Measured phases must not
 * wait on Playwright locators: each retry walks the whole transcript and skewed
 * earlier results by seconds. Build the app first, as `npm run showcase:capture` does, then run
 * `npx playwright test --config scripts/bench/playwright.config.ts`.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import type { DemoChat } from '../showcase/chats';
import type { DemoTask } from '../showcase/demo-workspace';
import { launchShowcaseApp, taskColumn } from '../showcase/electron-app';
import { startProfile, summarizeProfile } from './profile-summary';
import { startTrace, summarizeTrace } from './trace-summary';

const SIZES = (process.env.BENCH_SIZES ?? '100,1000,3000').split(',').map(Number);
const STREAM_CHUNKS = 500;
// BENCH_TRACE=1 records a Chrome trace of each stream and reports where the time went.
const TRACE = process.env.BENCH_TRACE === '1';
// BENCH_PROFILE=1 samples the renderer's JavaScript during each stream.
const PROFILE = process.env.BENCH_PROFILE === '1';
// Resuming a long history is slow; how slow is one of the results.
const RESUME_TIMEOUT_MS = 240_000;
const OUT_DIR = path.join(import.meta.dirname, '..', '..', '.tmp', 'bench');

const VARIANTS = {
  baseline: '',
  'content-visibility': `.chat-transcript > :is(.chat-user-turn, .chat-answer, [data-chat-id]) {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
  }`,
} as const;
type Variant = keyof typeof VARIANTS;

const CODE = Array.from({ length: 12 }, (_, i) => `const value${i} = compute(${i}); // ${i}`);
const answer = (i: number): string =>
  [
    `Round ${i}: I checked \`src/module-${i}.ts\` and found the issue.`,
    '- The loader retries without backoff\n- The cache key ignores the locale',
    ['```ts', ...CODE, '```'].join('\n'),
    'Next I will update the tests and run them again.',
  ].join('\n\n');
const FILE = Array.from({ length: 40 }, (_, i) => `${i + 1}\tconst line${i} = load(${i});`);
const TEST_OUTPUT = Array.from({ length: 20 }, (_, i) => ` ✓ suite ${i} passes (${i + 3} ms)`);

/** Roughly one transcript item per step, cycling through what a working session emits. */
const history = (size: number): DemoChat['history'] =>
  Array.from({ length: size }, (_, i) => {
    const file_path = `src/module-${i}.ts`;
    switch (i % 4) {
      case 0:
        return { text: answer(i) };
      case 1:
        return { tool: 'Read', input: { file_path }, result: FILE.join('\n') };
      case 2: {
        const input = { file_path, old_string: CODE[0], new_string: CODE[1] };
        return { tool: 'Edit', input, result: 'The file has been updated.' };
      }
      default:
        return { tool: 'Bash', input: { command: 'npm test' }, result: TEST_OUTPUT.join('\n') };
    }
  }).concat({ text: 'History end.' });

const benchTask = (size: number): DemoTask => ({
  slug: 'bench',
  name: 'Benchmark chat',
  prepare: () => {},
  chat: {
    sessionId: randomUUID(),
    prompt: 'Work through the backlog',
    history: history(size),
    reply: [
      {
        stream: `${Array.from({ length: 20 }, (_, i) => answer(i)).join('\n\n')}\n\nStream end.`,
        chunks: STREAM_CHUNKS,
      },
    ],
  },
});

type Metrics = Record<string, number>;
const readMetrics = async (cdp: CDPSession): Promise<Metrics> => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
};
const ms = (seconds: number): number => Math.round(seconds * 1000);
/** Renderer time spent between two snapshots, in ms. */
const rendererDelta = (before: Metrics, after: Metrics) => {
  const spent = (name: string) => ms(after[name] - before[name]);
  const [task, script, layout, style] = [
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
    'RecalcStyleDuration',
  ].map(spent);
  return {
    taskMs: task,
    scriptMs: script,
    layoutMs: layout,
    styleMs: style,
    // Mostly paint and compositing, done in software here (the harness disables the GPU).
    otherMs: task - script - layout - style,
    layouts: after.LayoutCount - before.LayoutCount,
  };
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
};
const frameStats = (intervals: number[]) => ({
  frameP50: percentile(intervals, 0.5),
  frameP95: percentile(intervals, 0.95),
  frameMax: Math.round(Math.max(0, ...intervals)),
  // Frames that took longer than 50 ms read as a visible hitch.
  slowFrames: intervals.filter((interval) => interval > 50).length,
});

/**
 * Waits until the transcript's last entry contains `text`, checking in the page
 * every 250 ms. A retrying Playwright locator would walk the whole transcript's
 * text and accessibility tree on every try, loading the renderer being measured.
 */
const waitForLastEntry = (page: Page, text: string, timeout: number) =>
  page.waitForFunction(
    (wanted) =>
      document
        .querySelector('[data-task-id="task-bench"] .chat-transcript > :last-child')
        ?.textContent?.includes(wanted) ?? false,
    text,
    { polling: 250, timeout },
  );

type FrameWindow = Window & { __benchFrames?: number[]; __benchStop?: boolean };
const startFrames = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as FrameWindow;
    w.__benchFrames = [];
    w.__benchStop = false;
    const tick = (now: number) => {
      w.__benchFrames?.push(now);
      if (!w.__benchStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopFrames = async (page: Page): Promise<number[]> => {
  const times = await page.evaluate(() => {
    const w = window as FrameWindow;
    w.__benchStop = true;
    return w.__benchFrames ?? [];
  });
  return times.slice(1).map((time, i) => time - times[i]);
};

/**
 * Pages from the bottom of the transcript to the top, two frames per page.
 * `heightShiftPx` sums how much the log's height changed on the way: entries
 * whose placeholder size differs from their real one move the content under
 * the reader, because the log turns scroll anchoring off.
 */
const scrollToTop = (page: Page) =>
  taskColumn(page, 'bench')
    .locator('.chat-scroll')
    .evaluate(async (log) => {
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const steps: number[] = [];
      let heightShiftPx = 0;
      let height = log.scrollHeight;
      // Only the reader's own input stops the log following new output; a bare
      // scrollTop change would be pulled back to the bottom on the next resize.
      log.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      while (log.scrollTop > 0 && steps.length < 2000) {
        const start = performance.now();
        log.scrollTop = Math.max(0, log.scrollTop - log.clientHeight * 0.9);
        await frame();
        await frame();
        steps.push(performance.now() - start);
        heightShiftPx += Math.abs(log.scrollHeight - height);
        height = log.scrollHeight;
      }
      return { steps, heightShiftPx: Math.round(heightShiftPx) };
    });

const mainCpuMs = async (app: Awaited<ReturnType<typeof launchShowcaseApp>>['app']) => {
  const { user, system } = await app.evaluate(() => process.cpuUsage());
  return (user + system) / 1000;
};

type Row = { items: number; variant: Variant } & Record<string, number | string>;
const rows: Row[] = [];
/** Renderer main-thread self time by trace event, in ms, per run. */
const traces: Record<string, Record<string, number>> = {};
/** Renderer JavaScript self time by function, in ms, per run. */
const profiles: Record<string, Record<string, number>> = {};

test.describe.configure({ mode: 'serial' });

for (const size of SIZES) {
  for (const variant of Object.keys(VARIANTS) as Variant[]) {
    test(`${size} items, ${variant}`, async () => {
      const { app, page, close } = await launchShowcaseApp({
        tasks: [benchTask(size)],
        focus: 'bench',
      });
      try {
        const column = taskColumn(page, 'bench');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        // Resume runs before the variant's CSS applies, so it measures the app as shipped.
        const launched = Date.now();
        const [resumeBefore, resumeCpuBefore] = [await readMetrics(cdp), await mainCpuMs(app)];
        await waitForLastEntry(page, 'History end.', RESUME_TIMEOUT_MS);
        const resumeMs = Date.now() - launched;
        const resumeMainCpuMs = Math.round((await mainCpuMs(app)) - resumeCpuBefore);
        const resume = rendererDelta(resumeBefore, await readMetrics(cdp));
        if (VARIANTS[variant]) await page.addStyleTag({ content: VARIANTS[variant] });
        const items = await column.locator('.chat-transcript > *').count();
        // Resolved before measuring: finding them by role walks the whole transcript.
        await expect(column.getByRole('option', { name: 'Sonnet 5' })).toBeAttached();
        const composer = column.getByRole('textbox', { name: 'Message Claude' });
        await composer.fill('Go');
        const input = await composer.elementHandle();
        if (!input) throw new Error('The composer is gone');

        const before = await readMetrics(cdp);
        const cpuBefore = await mainCpuMs(app);
        const stopTrace = TRACE ? await startTrace(cdp) : undefined;
        const stopProfile = PROFILE ? await startProfile(cdp) : undefined;
        await startFrames(page);
        const started = Date.now();
        await input.press('Enter');
        await waitForLastEntry(page, 'Stream end.', 120_000);
        const wallMs = Date.now() - started;
        const streamFrames = await stopFrames(page);
        const afterStream = await readMetrics(cdp);
        const cpuAfter = await mainCpuMs(app);
        if (stopTrace) traces[`${size} items, ${variant}`] = summarizeTrace(await stopTrace());
        if (stopProfile)
          profiles[`${size} items, ${variant}`] = summarizeProfile(await stopProfile());

        const scroll = await scrollToTop(page);
        const afterScroll = await readMetrics(cdp);

        const stream = rendererDelta(before, afterStream);
        const scrolled = rendererDelta(afterStream, afterScroll);
        rows.push({
          items: size,
          variant,
          entries: items,
          resumeMs,
          resumeMainCpuMs,
          'resume.rendererTaskMs': resume.taskMs,
          'resume.rendererScriptMs': resume.scriptMs,
          domNodes: afterStream.Nodes,
          heapMB: Math.round(afterStream.JSHeapUsedSize / 1e6),
          streamWallMs: wallMs,
          streamMainCpuMs: Math.round(cpuAfter - cpuBefore),
          ...Object.fromEntries(Object.entries(stream).map(([k, v]) => [`stream.${k}`, v])),
          ...Object.fromEntries(
            Object.entries(frameStats(streamFrames)).map(([k, v]) => [`stream.${k}`, v]),
          ),
          'scroll.pages': scroll.steps.length,
          'scroll.pageP95Ms': percentile(scroll.steps, 0.95),
          'scroll.pageMaxMs': Math.round(Math.max(0, ...scroll.steps)),
          'scroll.heightShiftPx': scroll.heightShiftPx,
          ...Object.fromEntries(Object.entries(scrolled).map(([k, v]) => [`scroll.${k}`, v])),
        });
      } finally {
        await close();
      }
    });
  }
}

test.afterAll(() => {
  if (!rows.length) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(
    OUT_DIR,
    `chat-stream-${new Date().toISOString().replace(/:/g, '-')}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({ rows, traces, profiles }, null, 2));
  console.table(rows);
  for (const [run, top] of Object.entries(traces)) {
    console.log(`\n${run}: renderer main thread, top self time (ms)`);
    console.table(top);
  }
  for (const [run, top] of Object.entries(profiles)) {
    console.log(`\n${run}: renderer JavaScript, top self time (ms)`);
    console.table(top);
  }
  console.log(`Results: ${file}`);
});
