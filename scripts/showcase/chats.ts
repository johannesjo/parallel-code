/**
 * Conversations for the demo tasks that open in chat view. `history` becomes
 * the Claude session file the app reads when it resumes the chat; `start` and
 * `reply` are what chat-agent.mjs plays live. Keep them consistent with the
 * worktrees in demo-workspace.ts: the chat's diffs should match the real ones.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** See chat-agent.mjs for what each step does. */
type ChatStep =
  | { text: string }
  | { stream: string; chunks?: number }
  | { tool: string; input: Record<string, unknown>; result?: string }
  | { approve: { tool: string; input: Record<string, unknown> }; after?: string };

export type DemoChat = {
  /** Resumed by the app, so it must be a UUID. */
  sessionId: string;
  prompt: string;
  history: ChatStep[];
  /** Played when the chat connects, e.g. a permission request. */
  start?: ChatStep[];
  /** Played when a scene sends a message; it never finishes, so the task stays working. */
  reply?: ChatStep[];
};

export const FORECAST_SOURCE = 'export const forecast = (city: string) => `Sunny in ${city}`;\n';

export const FIVE_DAY_HELPER =
  'export const fiveDay = (city: string) =>\n  [1, 2, 3, 4, 5].map((n) => ({ label: `Day ${n}`, summary: forecast(city) }));\n';

export const FIVE_DAY_VIEW = [
  "import { fiveDay } from '../forecast';",
  '',
  'export const FiveDay = (props: { city: string }) => (',
  '  <ol class="five-day">',
  '    {fiveDay(props.city).map((day) => (',
  '      <li>{day.label}: {day.summary}</li>',
  '    ))}',
  '  </ol>',
  ');',
  '',
].join('\n');

export const DATES_SOURCE =
  'export const dayKey = (date: Date) => date.toISOString().slice(0, 10);\n';

export const FORECAST_CHAT: DemoChat = {
  sessionId: '0b5f6f7e-2d4a-4f47-9a51-5f0c1d7e0a01',
  prompt: 'Add a 5-day forecast view',
  history: [
    { text: 'I’ll add a `fiveDay()` helper next to `forecast()` and a component that lists it.' },
    {
      tool: 'Edit',
      input: {
        file_path: 'src/forecast.ts',
        old_string: FORECAST_SOURCE,
        new_string: FORECAST_SOURCE + FIVE_DAY_HELPER,
      },
      result: 'The file src/forecast.ts has been updated.',
    },
    {
      tool: 'Write',
      input: { file_path: 'src/components/FiveDay.tsx', content: FIVE_DAY_VIEW },
      result: 'File created successfully at: src/components/FiveDay.tsx',
    },
    { tool: 'Bash', input: { command: 'npm test' }, result: '✓ 18 passed (412 ms)' },
    { text: 'The view renders five days from the existing forecast. Tests pass.' },
  ],
  reply: [
    { text: 'Adding min/max temperature to each day first, then the rain icon.' },
    { tool: 'Bash', input: { command: 'npm test -- FiveDay' } },
  ],
};

export const DATES_CHAT: DemoChat = {
  sessionId: '0b5f6f7e-2d4a-4f47-9a51-5f0c1d7e0a02',
  prompt: 'Dates are a day off in Sydney',
  history: [
    {
      tool: 'Bash',
      input: { command: 'npx vitest run test/dates.test.ts' },
      result:
        '✗ keeps the local day\n  expected "2026-09-24" to be "2026-09-25"\n\n1 failed (reproduced)',
    },
    {
      text: '`dayKey()` uses `toISOString()`, which converts to UTC, so evening forecasts in Sydney roll into the previous day. Formatting in the city’s time zone fixes it.',
    },
  ],
  start: [
    {
      approve: {
        tool: 'Edit',
        input: {
          file_path: 'src/dates.ts',
          old_string: DATES_SOURCE,
          new_string:
            "import { formatInZone } from './zone';\n\nexport const dayKey = (date: Date, timeZone: string) =>\n  formatInZone(date, timeZone);\n",
        },
      },
      after: 'Applied. Dates now follow the city’s time zone, and the Sydney test passes.',
    },
  ],
};

export const PLAN_CHAT: DemoChat = {
  sessionId: '0b5f6f7e-2d4a-4f47-9a51-5f0c1d7e0a03',
  prompt: 'Plan weather app v2 and start what is ready',
  history: [
    {
      text: 'I mapped v2 in the mind map: 7 ideas, 3 ready to start. I started a task for each of those and linked it to its node.',
    },
  ],
  reply: [
    { text: 'Breaking the 5-day forecast into smaller steps in the mind map.' },
    { stream: 'Min/max temperature comes first, since the rain icon' },
  ],
};

/**
 * Writes the history where the Claude Agent SDK looks for it: the session
 * file under `~/.claude/projects/`, named after the working directory.
 */
export const writeChatSession = (home: string, cwd: string, chat: DemoChat): void => {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  let parentUuid: string | null = null;
  const lines: string[] = [];
  const add = (type: 'user' | 'assistant', message: Record<string, unknown>): void => {
    const uuid = randomUUID();
    const entry = { type, uuid, parentUuid, sessionId: chat.sessionId, cwd, isSidechain: false };
    lines.push(JSON.stringify({ ...entry, timestamp: new Date().toISOString(), message }));
    parentUuid = uuid;
  };
  const assistant = (content: unknown[]): void =>
    add('assistant', { id: `msg_${randomUUID()}`, role: 'assistant', content });
  add('user', { role: 'user', content: chat.prompt });
  for (const step of chat.history) {
    if ('text' in step) assistant([{ type: 'text', text: step.text }]);
    if (!('tool' in step)) continue;
    const id = `toolu_${randomUUID().replace(/-/g, '')}`;
    assistant([{ type: 'tool_use', id, name: step.tool, input: step.input }]);
    const result = { type: 'tool_result', tool_use_id: id, content: step.result ?? '' };
    add('user', { role: 'user', content: [result] });
  }
  fs.writeFileSync(path.join(dir, `${chat.sessionId}.jsonl`), `${lines.join('\n')}\n`);
};

/** Where chat-agent.mjs finds the live part, shared by the seed and the `claude` stub. */
export const chatScriptDir = (demoDir: string): string => path.join(demoDir, 'chats');

/** Writes what chat-agent.mjs plays live, found by the session id it is started with. */
export const writeChatScript = (demoDir: string, chat: DemoChat): void => {
  const scriptDir = chatScriptDir(demoDir);
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, `${chat.sessionId}.json`),
    JSON.stringify({ start: chat.start, reply: chat.reply }),
  );
};
