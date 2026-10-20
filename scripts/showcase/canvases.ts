/**
 * Canvas content for the demo: the v2 plan mind map on the planning task and
 * the reasoning graph of the Sydney date bug. Scenes publish the "live" parts
 * the way an agent's MCP call does, so the canvases show as agent-driven.
 */

/** Mind map nodes that link to demo tasks, by task slug. */
const PLAN_LINKS: Record<string, { slug: string; name: string }> = {
  forecast: { slug: 'five-day-forecast', name: 'Add a 5-day forecast view' },
  dates: { slug: 'sydney-dates', name: 'Fix dates a day off in Sydney' },
  docs: { slug: 'readme-setup', name: 'Document local setup' },
};

export const PLAN_MAP = {
  version: 1,
  revision: 1,
  records: [
    { id: 'root', title: 'Weather app v2', detail: '' },
    { id: 'forecast', parent: 'root', title: '5-day forecast', detail: 'One row per day.' },
    { id: 'dates', parent: 'root', title: 'Dates off by a day', detail: 'Reported from Sydney.' },
    {
      id: 'docs',
      parent: 'root',
      title: 'Local setup docs',
      detail: 'Install, API key, dev server.',
    },
    { id: 'alerts', parent: 'root', title: 'Rain alerts', detail: 'Notify before rain starts.' },
    { id: 'push', parent: 'alerts', title: 'Needs a push service', detail: '' },
    {
      id: 'offline',
      parent: 'root',
      title: 'Offline cache',
      detail: 'Last forecast without network.',
    },
  ],
  relations: [],
};

export const planMapLinks = (): unknown[] =>
  Object.entries(PLAN_LINKS).map(([nodeId, task]) => ({
    canvas: 'mindmap',
    nodeId,
    taskId: `task-${task.slug}`,
    taskName: task.name,
  }));

/** What the planning agent adds while the scene watches; new nodes pulse briefly. */
export const PLAN_MAP_LIVE_UPDATE = {
  expectedRevision: PLAN_MAP.revision,
  operations: [
    {
      type: 'insert',
      node: { id: 'minmax', parent: 'forecast', title: 'Min/max temperature', detail: '' },
    },
    { type: 'insert', node: { id: 'icons', parent: 'forecast', title: 'Rain icon', detail: '' } },
  ],
};

const DATES_SOURCE = { label: 'dayKey', path: 'src/dates.ts', line: 1 };
const TEST_SOURCE = { label: 'failing test', path: 'test/dates.test.ts', line: 4 };

/** The Sydney task's investigation, as the agent's first reasoning update. */
export const DATES_REASONING = {
  runId: null,
  newRunId: 'sydney-dates',
  expectedRevision: 0,
  caption: 'Fix proposed; waiting for approval',
  operations: [
    {
      type: 'insert',
      node: {
        id: 'goal',
        title: 'Why are dates a day off in Sydney?',
        detail: 'Evening forecasts show under the next day.',
        kind: 'goal',
        status: 'unresolved',
      },
    },
    {
      type: 'insert',
      node: {
        id: 'utc',
        parent: 'goal',
        title: 'toISOString() converts to UTC',
        detail: 'dayKey() slices the UTC date, not the local one.',
        kind: 'hypothesis',
        status: 'supported',
        confidence: 0.9,
        sources: [DATES_SOURCE],
      },
    },
    {
      type: 'insert',
      node: {
        id: 'repro',
        parent: 'utc',
        title: '22:00 in Sydney becomes the previous day',
        detail: 'The new test fails exactly as reported.',
        kind: 'observation',
        status: 'observed',
        sources: [TEST_SOURCE],
      },
    },
    {
      type: 'insert',
      node: {
        id: 'api',
        parent: 'goal',
        title: 'The API sends the wrong zone',
        detail: 'Would explain it without any bug in our code.',
        kind: 'hypothesis',
        status: 'rejected',
        confidence: 0.1,
      },
    },
    {
      type: 'insert',
      node: {
        id: 'offsets',
        parent: 'api',
        title: 'Responses carry +10:00 offsets',
        detail: 'Timestamps parse to the right instant.',
        kind: 'observation',
        status: 'observed',
      },
    },
    {
      type: 'insert',
      node: {
        id: 'fix',
        parent: 'utc',
        title: 'Format in the city’s time zone',
        detail: 'formatInZone(date, city.timeZone) instead of toISOString().',
        kind: 'decision',
        status: 'proposed',
        sources: [DATES_SOURCE],
      },
    },
    {
      type: 'insert_relation',
      relation: {
        id: 'repro-supports',
        source: 'repro',
        target: 'utc',
        kind: 'supports',
        rationale: 'Reproduces the off-by-one exactly.',
      },
    },
    {
      type: 'insert_relation',
      relation: {
        id: 'offsets-challenge',
        source: 'offsets',
        target: 'api',
        kind: 'challenges',
        rationale: 'The offsets are correct.',
      },
    },
  ],
};
