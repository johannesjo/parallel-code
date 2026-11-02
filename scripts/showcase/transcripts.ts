/**
 * Canned terminal sessions for the demo tasks, replayed by `fake-agent.mjs
 * --transcript`. Fictional on purpose: no real agent produced them. Lines stay
 * short because three task columns share a 1536 px window.
 */
const dim = (text: string): string => `\x1b[90m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;

/** How a CLI marks its prompt and tool calls. Claude tasks use chat view instead (chats.ts). */
type AgentStyle = { prompt: string; bullet: string };
const GEMINI: AgentStyle = { prompt: bold('>'), bullet: '\x1b[34m✦\x1b[0m' };
const CODEX: AgentStyle = { prompt: bold('›'), bullet: '\x1b[32m•\x1b[0m' };
const COPILOT: AgentStyle = { prompt: bold('>'), bullet: '\x1b[35m●\x1b[0m' };

export type DemoSession = { prompt: string; transcript: string };

/** Lines starting with `* ` are tool calls, shown with the agent's bullet. */
const session = (style: AgentStyle, prompt: string, lines: string[]): DemoSession => ({
  prompt,
  transcript: [
    `${style.prompt} ${prompt}`,
    '',
    ...lines.map((line) => (line.startsWith('* ') ? `${style.bullet} ${line.slice(2)}` : line)),
  ].join('\n'),
});

/** Finished and committed: ends on an idle prompt. */
export const README_SESSION = session(GEMINI, 'Document local setup in README', [
  '* Read package.json',
  '* Update README.md',
  dim('  + 6 lines'),
  '* git commit -m "docs: add setup"',
  dim('  1 file changed, 6 insertions'),
  '',
  'Done. The README covers install,',
  'the API key and the dev server.',
  '',
  GEMINI.prompt + ' ',
]);

// The board scene's extra tasks: one per lane state, so the board reads as a
// fleet. Busy ones keep a spinner going (`busy` in demo-workspace.ts).

/** Asks before writing: ends on a [Y/n] question, so the task needs you. */
export const UNITS_SESSION = session(CODEX, 'Add a °C/°F toggle', [
  '* Read src/forecast.ts',
  '* Edit src/forecast.ts, src/settings.ts',
  dim('  +24 -3'),
  '',
  'Apply changes to 2 files? [Y/n]',
]);

export const OFFLINE_SESSION = session(GEMINI, 'Cache forecasts for offline use', [
  '* Read src/api/weather.ts',
  '* Write src/cache.ts',
  dim('  + 31 lines'),
  '',
]);

export const AIR_QUALITY_SESSION = session(CODEX, 'Show the air quality index', [
  '* Read src/api/weather.ts',
  '* Edit src/api/air.ts',
  dim('  +18 -0'),
  '',
]);

export const CONTRAST_SESSION = session(COPILOT, 'Fix contrast in the dark theme', [
  '* Read src/styles.css',
  '* Edit src/styles.css',
  dim('  +6 -6'),
  '',
]);

/** Finished and committed: ends on an idle prompt. */
export const RAIN_SESSION = session(COPILOT, 'Rain alerts at 8 am', [
  '* Write src/alerts.ts',
  '* git commit -m "feat: rain alerts"',
  dim('  1 file changed, 22 insertions'),
  '',
  'Done. Alerts fire at 8 am local time.',
  '',
  COPILOT.prompt + ' ',
]);

export const HOURLY_SESSION = session(CODEX, 'Hourly temperature chart', [
  '* Write src/components/Hourly.tsx',
  '* git commit -m "feat: hourly chart"',
  '* gh pr create',
  '',
  'Opened a pull request.',
  '',
  CODEX.prompt + ' ',
]);

export const CITY_SEARCH_SESSION = session(GEMINI, 'Fuzzy city search', [
  '* Read src/api/weather.ts',
  '',
  'Paused until the geocoding API is chosen.',
  '',
  GEMINI.prompt + ' ',
]);

/**
 * The change tour of the forecast task, returned by the `claude` stub for the
 * tour request. Its locations must be lines of that task's real diff.
 */
export const FORECAST_TOUR = {
  gist: {
    title: 'Adds a 5-day forecast list',
    explanation:
      'A new FiveDay component lists one row per day, built by a new fiveDay() helper in forecast.ts. Existing behaviour does not change.',
  },
  stops: [
    {
      label: 'ENTRY POINT',
      title: 'fiveDay() builds the five daily entries',
      explanation:
        'It maps days 1–5 to a label and a summary. Every day reuses today’s forecast text for now; the weather API is not called per day yet.',
      whyItMatters: 'The view shows placeholder data until the API returns daily values.',
      tone: 'important',
      locations: [{ filePath: 'src/forecast.ts', line: 2, endLine: 3 }],
    },
    {
      label: 'UI',
      title: 'FiveDay renders the list',
      explanation:
        'A plain ordered list, one item per day, fed by fiveDay(). No styling and no loading state yet.',
      tone: 'neutral',
      locations: [{ filePath: 'src/components/FiveDay.tsx', line: 3, endLine: 9 }],
    },
    {
      label: 'CHECK',
      title: 'Days are labelled “Day 1” to “Day 5”',
      explanation:
        'Readers expect weekday names. Deriving them needs the city’s time zone, which the Sydney date fix changes too.',
      tone: 'risk',
      locations: [{ filePath: 'src/forecast.ts', line: 3 }],
    },
  ],
  verify: {
    title: 'Before merging',
    explanation: 'Open the view for two cities and check each day’s label and summary.',
    locations: [{ filePath: 'src/components/FiveDay.tsx', line: 6 }],
  },
};
