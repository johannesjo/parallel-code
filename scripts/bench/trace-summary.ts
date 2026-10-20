/**
 * Where a renderer's main thread spent its time, from a Chrome trace: the
 * events with the most self time (their duration minus their children's).
 */
import type { CDPSession } from '@playwright/test';

type TraceEvent = {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
};

const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink',
  'cc',
  'v8',
  'v8.execute',
];

/** Starts tracing; the returned function stops it and resolves with the events. */
export const startTrace = async (cdp: CDPSession): Promise<() => Promise<TraceEvent[]>> => {
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', ({ value }) =>
    events.push(...(value as unknown as TraceEvent[])),
  );
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: CATEGORIES },
  });
  return async () => {
    const complete = new Promise<void>((resolve) =>
      cdp.once('Tracing.tracingComplete', () => resolve()),
    );
    await cdp.send('Tracing.end');
    await complete;
    return events;
  };
};

/** Self time per event name on one thread; events nest by time range. */
const selfTimes = (events: TraceEvent[]): Map<string, number> => {
  const totals = new Map<string, number>();
  const stack: { end: number; name: string }[] = [];
  const sorted = events
    .filter((event) => event.ph === 'X' && event.dur !== undefined)
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  for (const event of sorted) {
    const dur = event.dur ?? 0;
    while (stack.length && stack[stack.length - 1].end <= event.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) totals.set(parent.name, (totals.get(parent.name) ?? 0) - dur);
    totals.set(event.name, (totals.get(event.name) ?? 0) + dur);
    stack.push({ end: event.ts + dur, name: event.name });
  }
  return totals;
};

/**
 * The busiest renderer main thread's top events by self time, in ms. The app
 * window is the busiest one; other renderers (previews, canvases) idle here.
 */
export const summarizeTrace = (events: TraceEvent[], top = 12): Record<string, number> => {
  const byThread = new Map<string, TraceEvent[]>(
    events
      .filter((event) => event.ph === 'M' && event.args?.name === 'CrRendererMain')
      .map((event) => [`${event.pid}:${event.tid}`, []]),
  );
  for (const event of events) byThread.get(`${event.pid}:${event.tid}`)?.push(event);
  const busiest = [...byThread.values()].map(selfTimes).sort((a, b) => sum(b) - sum(a))[0];
  if (!busiest) return {};
  return Object.fromEntries(
    [...busiest]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, us]) => [name, Math.round(us / 1000)]),
  );
};

const sum = (totals: Map<string, number>): number =>
  [...totals.values()].reduce((total, value) => total + value, 0);
