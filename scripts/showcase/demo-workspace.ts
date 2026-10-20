/**
 * The fictional workspace a showcase run starts from: a small `weather-app`
 * repository and the app state that links it. With `withTasks`, three tasks
 * are restored mid-flight (working, needing input, ready) from real worktrees
 * and scripted conversations, so the app looks busy without any agent running.
 * Claude tasks open in chat view (chats.ts); others replay a terminal transcript.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLAN_MAP, planMapLinks } from './canvases';
import {
  DATES_CHAT,
  DATES_SOURCE,
  type DemoChat,
  FIVE_DAY_HELPER,
  FIVE_DAY_VIEW,
  FORECAST_CHAT,
  FORECAST_SOURCE,
  PLAN_CHAT,
  writeChatScript,
  writeChatSession,
} from './chats';
import { type DemoSession, README_SESSION } from './transcripts';

const FAKE_AGENT = path.resolve(import.meta.dirname, '..', 'fake-agent.mjs');

const DEMO_AGENT = {
  id: 'demo-agent',
  name: 'Demo agent',
  command: FAKE_AGENT,
  args: ['--profile', 'demo'],
  resume_args: [],
  skip_permissions_args: [],
  description: 'Scripted agent for showcase recordings',
};

const BASE_FILES: Record<string, string> = {
  'README.md': '# Weather app\n\nForecasts for your city.\n',
  'package.json': '{ "name": "weather-app", "scripts": { "dev": "vite", "test": "vitest" } }\n',
  'src/forecast.ts': FORECAST_SOURCE,
  'src/dates.ts': DATES_SOURCE,
  'src/api/weather.ts': 'export const fetchWeather = (city: string) => fetch(`/api/${city}`);\n',
};

/** A Claude Code task in chat view, or any agent's terminal replaying a transcript. */
type DemoAgent =
  | { chat: DemoChat }
  | {
      session: DemoSession;
      /** The agent the task shows; the replay runs whatever the label says. */
      agentName: string;
      /** Spinner label; the agent keeps printing and reads as working. */
      busy?: string;
    };

export type DemoTask = DemoAgent & {
  slug: string;
  name: string;
  /** Text in the task's notes panel. */
  notes?: string;
  /** Leaves the worktree in the state the transcript describes. */
  prepare: (worktree: string) => void;
  /** Extra persisted task fields, such as a canvas. */
  state?: Record<string, unknown>;
};

// The user's git config must not apply: commit signing, hooks or a missing
// identity would make a seed hang or fail, or run their hooks on the demo repo.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
};

const git = (cwd: string, args: string[]): void => {
  // stderr piped, not ignored: a failure's message then says why.
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'ignore', 'pipe'] });
};

const commit = (cwd: string, message: string): void => {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', message]);
};

const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
};

const DEMO_TASKS: DemoTask[] = [
  {
    slug: 'five-day-forecast',
    name: 'Add a 5-day forecast view',
    chat: FORECAST_CHAT,
    notes:
      'Next: show min/max temperature and a rain icon per day.\n\nReuse the icons in src/icons, no new dependency.',
    prepare: (worktree) =>
      writeFiles(worktree, {
        'src/components/FiveDay.tsx': FIVE_DAY_VIEW,
        'src/forecast.ts': FORECAST_SOURCE + FIVE_DAY_HELPER,
      }),
  },
  {
    slug: 'sydney-dates',
    name: 'Fix dates a day off in Sydney',
    chat: DATES_CHAT,
    prepare: (worktree) =>
      writeFiles(worktree, {
        'test/dates.test.ts':
          "import { dayKey } from '../src/dates';\n\ntest('keeps the local day', () => {\n  expect(dayKey(new Date('2026-09-25T22:00:00+10:00'))).toBe('2026-09-25');\n});\n",
      }),
  },
  {
    slug: 'readme-setup',
    name: 'Document local setup',
    session: README_SESSION,
    agentName: 'Gemini CLI',
    prepare: (worktree) => {
      writeFiles(worktree, {
        'README.md': `${BASE_FILES['README.md']}\n## Setup\n\n1. Install: \`npm install\`\n2. Add \`WEATHER_API_KEY\` to \`.env\`\n3. Start: \`npm run dev\`\n`,
      });
      commit(worktree, 'docs: add setup');
    },
  },
];

/** Hosts the v2 plan mind map, whose branches link to the other demo tasks. */
const PLANNER_TASK: DemoTask = {
  slug: 'plan-v2',
  name: 'Plan weather app v2',
  chat: PLAN_CHAT,
  prepare: () => {},
  state: {
    mindMap: PLAN_MAP,
    canvasTabs: [{ kind: 'mindmap' }],
    canvasActiveTab: 'mindmap',
    canvasTaskLinks: planMapLinks(),
  },
};

const createRepo = (repo: string): void => {
  writeFiles(repo, BASE_FILES);
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, 'init');
  // Shared by every worktree, and invisible in the repo: the app writes agent
  // settings into .claude/, which would otherwise show up as changed files.
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.worktrees/\n.claude/\n');
};

/**
 * - `withTasks`: restore the three demo tasks.
 * - `tasks`: restore these tasks instead, e.g. a benchmark's.
 * - `planner`: add the planning task with the v2 mind map, first in line.
 * - `focus`: the slug of the task to open in focus mode.
 * - `shell`: give the focused task an open shell.
 */
export type DemoWorkspaceOptions = {
  withTasks?: boolean;
  tasks?: DemoTask[];
  planner?: boolean;
  focus?: string;
  shell?: boolean;
};

/** Claude Code as the app ships it, so the task can open in chat view. */
const CLAUDE_CODE_AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: ['--dangerously-skip-permissions'],
  description: "Anthropic's Claude Code CLI agent",
};

type SeedContext = { dir: string; repo: string; home: string };

/** The task's agent fields: a resumable chat, or a terminal replaying its transcript. */
const agentFields = (
  { dir, home }: SeedContext,
  task: DemoTask,
  worktreePath: string,
): Record<string, unknown> => {
  if ('chat' in task) {
    writeChatSession(home, worktreePath, task.chat);
    writeChatScript(dir, task.chat);
    return {
      prompt: task.chat.prompt,
      agentDef: CLAUDE_CODE_AGENT,
      mainAgentView: 'chat',
      claudeChatSessionId: task.chat.sessionId,
    };
  }
  const transcript = path.join(dir, 'transcripts', `${task.slug}.ansi`);
  writeFiles(path.dirname(transcript), { [path.basename(transcript)]: task.session.transcript });
  const busyArgs = task.busy ? ['--busy', task.busy] : [];
  return {
    prompt: task.session.prompt,
    agentDef: {
      ...DEMO_AGENT,
      // Its own id, so the app never swaps in a real agent's settings.
      id: `demo-${task.slug}`,
      name: task.agentName,
      args: ['--transcript', transcript, ...busyArgs],
    },
  };
};

const createTask = (context: SeedContext, task: DemoTask, shells: number): [string, unknown] => {
  const branchName = `task/${task.slug}`;
  const worktreePath = path.join(context.repo, '.worktrees', branchName);
  git(context.repo, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
  task.prepare(worktreePath);
  const agentId = `agent-${task.slug}`;
  const { prompt, ...agent } = agentFields(context, task, worktreePath);
  return [
    `task-${task.slug}`,
    {
      id: `task-${task.slug}`,
      name: task.name,
      projectId: 'demo',
      branchName,
      worktreePath,
      notes: task.notes ?? '',
      lastPrompt: prompt,
      promptHistory: [{ text: prompt, agentId }],
      shellCount: shells,
      ...agent,
      agentIds: [agentId],
      selectedAgentId: agentId,
      // Already prompted: a restored task must not send anything to its agent.
      promptedAgentIds: [agentId],
      gitIsolation: 'worktree',
      baseBranch: 'main',
      ...task.state,
    },
  ];
};

/**
 * Creates the demo repository in `dir` and writes the app state (and Claude
 * chat sessions) that open it into the throwaway `home`. Returns the
 * repository path.
 */
export const seedDemoWorkspace = (
  dir: string,
  home: string,
  options: DemoWorkspaceOptions = {},
): string => {
  const repo = path.join(dir, 'weather-app');
  createRepo(repo);
  const demoTasks =
    options.tasks ??
    (options.withTasks ? [...(options.planner ? [PLANNER_TASK] : []), ...DEMO_TASKS] : []);
  const tasks = demoTasks.map((task) =>
    createTask({ dir, repo, home }, task, options.shell && task.slug === options.focus ? 1 : 0),
  );
  const focusId = options.focus ? `task-${options.focus}` : undefined;
  const state = {
    projects: [{ id: 'demo', name: 'weather-app', path: repo, color: 'hsl(200, 70%, 75%)' }],
    lastProjectId: 'demo',
    lastAgentId: DEMO_AGENT.id,
    taskOrder: tasks.map(([id]) => id),
    collapsedTaskOrder: [],
    tasks: Object.fromEntries(tasks),
    activeTaskId: focusId ?? tasks[0]?.[0] ?? null,
    // Three columns at the agent pane's minimum width fit the showcase window
    // beside a slightly narrower sidebar (default 240).
    panelUserSize: {
      'sidebar:width': 220,
      ...Object.fromEntries(tasks.map(([id]) => [`tiling:${id}`, 420])),
    },
    panelUserSizeMigratedV2: true,
    sidebarVisible: true,
    keybindingMigrationDismissed: true,
    focusMode: Boolean(focusId && tasks.length > 0),
    // One theme for every shot, so stills and videos cut together.
    appearanceMode: 'dark',
    darkThemePreset: 'noir',
    // Delegation needs a real agent connected to the app's MCP server; without
    // one, chat tasks show a "start a new task session" banner.
    mcpOrchestrationEnabled: false,
    customAgents: [DEMO_AGENT],
  };
  // Electron names the profile after the entry script's package ("Electron"),
  // and an unpackaged run appends "-dev"; see electron/user-data-dir.ts.
  writeFiles(path.join(home, '.config', 'Electron-dev'), { 'state.json': JSON.stringify(state) });
  return repo;
};
