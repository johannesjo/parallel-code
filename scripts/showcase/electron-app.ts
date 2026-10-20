/**
 * Launches the built app for a scripted showcase recording: a throwaway home
 * directory, a fictional demo repository, and a seeded app state, so no
 * recording ever shows real projects, sessions or tokens.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
import { chatScriptDir } from './chats';
import { type DemoWorkspaceOptions, seedDemoWorkspace } from './demo-workspace';
import { FORECAST_TOUR } from './transcripts';
import { recorderLaunchArgs, startRecording } from './video-kit/recorder';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 1536 × 864 CSS pixels at 1.25× records at exactly 1920 × 1080. */
export const WINDOW = { width: 1536, height: 864, deviceScaleFactor: 1.25 };
export const VIDEO_SIZE = {
  width: WINDOW.width * WINDOW.deviceScaleFactor,
  height: WINDOW.height * WINDOW.deviceScaleFactor,
};

export type ShowcaseApp = {
  app: ElectronApplication;
  page: Page;
  close: () => Promise<void>;
};

// An allowlist rather than all of process.env: the parent shell can carry API
// keys, agent-session tokens and CLAUDE_CONFIG_DIR / CODEX_HOME, which would
// point the app back at real sessions and usage data despite the fake HOME.
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
// Proxies included: behind one, a real agent cannot reach its API without them.
const PASSED_ENV = [
  ...['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'],
  ...PROXY_ENV.flatMap((name) => [name, name.toLowerCase()]),
];

// The agent CLIs the app offers (electron/ipc/agents.ts). A fake HOME hides
// logins kept in files, but not one a CLI keeps in a system keyring. Stubs
// first on PATH make sure no showcase starts a real, paid agent.
const REAL_AGENT_COMMANDS = ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'agy'];

/** Agents a scene may opt in to; pinned-agent.mjs holds them to their cheapest model. */
type RealAgent = 'claude' | 'codex';

const PINNED_AGENT = path.join(import.meta.dirname, 'pinned-agent.mjs');
const CHAT_AGENT = path.join(import.meta.dirname, 'chat-agent.mjs');

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const findOnPath = (command: string): string => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not in this PATH entry; keep looking.
    }
  }
  throw new Error(`realAgents: "${command}" is not on PATH`);
};

const BLOCKED = (command: string): string =>
  `echo "${command}: real agents are disabled in showcase runs (scripts/showcase/README.md)" >&2\nexit 1\n`;

/**
 * A blocked `claude` still answers the app's change-tour request (recognised by
 * its system prompt) with the canned tour, and serves chat-view tasks from
 * their scripts, so neither needs a model.
 */
const claudeTourStub = (tourFile: string, chatScripts: string): string =>
  [
    '#!/bin/sh',
    'case "$*" in',
    `  *"requested tour schema"*) cat >/dev/null; cat ${shellQuote(tourFile)}; exit 0 ;;`,
    // A task in chat view: chat-agent.mjs plays its script instead of a model.
    `  *"--input-format stream-json"*) exec ${[process.execPath, CHAT_AGENT, chatScripts].map(shellQuote).join(' ')} "$@" ;;`,
    'esac',
    BLOCKED('claude'),
  ].join('\n');

const agentStub = (command: string, realAgents: RealAgent[], dir: string): string => {
  if (realAgents.some((agent) => agent === command)) {
    const target = [process.execPath, PINNED_AGENT, command, findOnPath(command)].map(shellQuote);
    return `#!/bin/sh\nexec ${target.join(' ')} "$@"\n`;
  }
  if (command !== 'claude') return `#!/bin/sh\n${BLOCKED(command)}`;
  const tourFile = path.join(dir, 'change-tour.json');
  fs.writeFileSync(tourFile, JSON.stringify(FORECAST_TOUR));
  return claudeTourStub(tourFile, chatScriptDir(dir));
};

const blockRealAgents = (dir: string, realAgents: RealAgent[]): string => {
  const bin = path.join(dir, 'blocked-agents');
  fs.mkdirSync(bin);
  for (const command of REAL_AGENT_COMMANDS) {
    fs.writeFileSync(path.join(bin, command), agentStub(command, realAgents, dir), {
      mode: 0o755,
    });
  }
  return bin;
};

/**
 * Task shells start the user's login shell with the throwaway home. Without an
 * rc file zsh opens its new-user wizard, and a default prompt shows the host
 * name; both would end up in screenshots.
 *
 * At startup the app also replaces its PATH with the one `$SHELL -ilc` reports
 * (fixEnv in electron/main.ts), and system login files such as /etc/profile
 * may rebuild PATH. The files that shell reads after them put the agent stubs
 * back in front.
 */
const seedShellRc = (home: string, blockedAgentsBin: string): void => {
  fs.mkdirSync(home, { recursive: true });
  const stubsFirst = `export PATH=${shellQuote(blockedAgentsBin)}:"$PATH"\n`;
  // PROMPT_EOL_MARK: no inverse `%` when the shell starts after partial output.
  fs.writeFileSync(
    path.join(home, '.zshrc'),
    `PROMPT='%F{cyan}%1~%f $ '\nPROMPT_EOL_MARK=''\n${stubsFirst}`,
  );
  fs.writeFileSync(path.join(home, '.bashrc'), "PS1='\\[\\e[36m\\]\\W\\[\\e[0m\\] $ '\n");
  // Login bash reads the first of these; sh and dash read .profile.
  for (const file of ['.bash_profile', '.profile']) {
    fs.writeFileSync(path.join(home, file), stubsFirst);
  }
};

// A refresh during the run would rotate the token in the copy, which can sign
// out the real login; a short run never gets near this margin.
const LOGIN_MIN_VALIDITY_MS = 30 * 60_000;

/**
 * Lets an opted-in Claude Code start: copies only its login file into the
 * throwaway home (deleted with it) and skips the first-run and folder-trust
 * screens for the demo repository and its worktrees.
 */
const seedClaudeLogin = (home: string, repo: string): void => {
  const source = path.join(os.homedir(), '.claude', '.credentials.json');
  const login = JSON.parse(fs.readFileSync(source, 'utf8')) as {
    claudeAiOauth?: { expiresAt?: number };
  };
  const expiresAt = login.claudeAiOauth?.expiresAt ?? 0;
  if (expiresAt - Date.now() < LOGIN_MIN_VALIDITY_MS) {
    throw new Error(
      'realAgents: the Claude login expires within 30 minutes; run `claude` once to refresh it',
    );
  }
  const target = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  // close() deletes it with the home; this covers a run that exits without it.
  // A killed process (SIGKILL, unhandled SIGINT) still leaves it behind.
  process.once('exit', () => fs.rmSync(target, { force: true }));
  const settings = {
    hasCompletedOnboarding: true,
    projects: { [repo]: { hasTrustDialogAccepted: true } },
  };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(settings));
  // Spinner tips are noise in recordings.
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ spinnerTipsEnabled: false }),
  );
};

const showcaseEnv = (home: string, blockedAgentsBin: string): Record<string, string> => ({
  ...Object.fromEntries(
    PASSED_ENV.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
  PATH: [blockedAgentsBin, process.env.PATH].filter(Boolean).join(path.delimiter),
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
});

const startApp = async (page: Page, app: ElectronApplication): Promise<void> => {
  const window = await app.browserWindow(page);
  await window.evaluate((w, size) => {
    w.unmaximize();
    w.setContentSize(size.width, size.height);
  }, WINDOW);
  // Fails loudly if Electron's profile naming changes and the seed is not read.
  await expect(page.getByText('weather-app').first(), 'seeded state.json not loaded').toBeVisible();
};

// A fixed, short path: the app shows worktree paths, and a random temp name
// would end up in every screenshot. The marker proves a leftover is ours, and
// holds the pid of the run that owns it.
const DEMO_DIR = path.join(os.tmpdir(), 'pc-demo');
const DEMO_MARKER = '.parallel-code-showcase';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const createDemoDir = (): string => {
  const marker = path.join(DEMO_DIR, DEMO_MARKER);
  if (fs.existsSync(DEMO_DIR)) {
    if (!fs.existsSync(marker)) {
      throw new Error(`${DEMO_DIR} exists and is not a showcase run's; move it away first`);
    }
    const owner = Number(fs.readFileSync(marker, 'utf8'));
    if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
      throw new Error(
        `${DEMO_DIR} belongs to a showcase run that is still running (pid ${owner}); ` +
          'wait for it, or delete the directory if that process is not a showcase run',
      );
    }
    // Left behind by a run that crashed before cleaning up.
    fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DEMO_DIR);
  fs.writeFileSync(marker, String(process.pid));
  return DEMO_DIR;
};

/**
 * Starts `dist-electron/main.js` (build it first) with a fresh profile and a
 * window sized for `VIDEO_SIZE` recordings. `withTasks` restores three demo
 * tasks in different states; see demo-workspace.ts. `realAgents` lets those
 * CLIs run, pinned to their cheapest model; every other agent stays blocked.
 */
export const launchShowcaseApp = async (
  options: DemoWorkspaceOptions & { realAgents?: RealAgent[] } = {},
): Promise<ShowcaseApp> => {
  // The Electron binary path and --ozone-platform=headless below are Linux's.
  if (process.platform !== 'linux') {
    throw new Error(`Showcase runs need Linux; this is ${process.platform}`);
  }
  // The seeded chat tasks resume sessions that chats.ts made up. With a real
  // Claude, the app would hand those to the billed CLI instead of chat-agent.mjs.
  if ((options.withTasks || options.tasks) && options.realAgents?.includes('claude')) {
    throw new Error('withTasks and tasks cannot be combined with realAgents: ["claude"]');
  }
  const dir = createDemoDir();
  const removeDir = (): void => fs.rmSync(dir, { recursive: true, force: true });
  let app: ElectronApplication | undefined;
  try {
    const home = path.join(dir, 'home');
    const blockedAgentsBin = blockRealAgents(dir, options.realAgents ?? []);
    seedShellRc(home, blockedAgentsBin);
    const repo = seedDemoWorkspace(dir, home, options);
    if (options.realAgents?.includes('claude')) seedClaudeLogin(home, repo);
    app = await _electron.launch({
      executablePath: path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron'),
      args: [
        '--no-sandbox',
        // Offscreen rendering: no window on the desktop, and no GPU needed. A
        // windowed run crashes where the GPU device is unavailable (sandboxes, CI).
        '--ozone-platform=headless',
        '--disable-gpu',
        ...recorderLaunchArgs(WINDOW.deviceScaleFactor),
        path.join(REPO_ROOT, 'dist-electron', 'main.js'),
      ],
      cwd: REPO_ROOT,
      env: showcaseEnv(home, blockedAgentsBin),
    });
    const page = await app.firstWindow();
    await startApp(page, app);
    const started = app;
    return {
      app: started,
      page,
      close: async () => {
        // Headless GTK cannot show the running-terminals confirmation dialog.
        // Stop this isolated showcase's terminals before requesting a normal quit.
        await page.evaluate(() =>
          (
            window as unknown as {
              electron: { ipcRenderer: { invoke: (channel: string) => Promise<unknown> } };
            }
          ).electron.ipcRenderer.invoke('kill_all_agents'),
        );
        await started.close();
        removeDir();
      },
    };
  } catch (error) {
    await app?.close();
    removeDir();
    throw error;
  }
};

/**
 * Records `scene` to `file`. A failing scene still finalizes the recording, so
 * ffmpeg does not wait for frames that never come.
 */
export const recordScene = async (
  page: Page,
  file: string,
  scene: () => Promise<void>,
): Promise<void> => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const recording = await startRecording(page, { path: file, size: VIDEO_SIZE });
  try {
    await scene();
  } catch (error) {
    // The scene's error is the one worth reporting; a stop failure is secondary.
    await recording.stop().catch((stopError: unknown) => {
      console.warn('Recording did not stop cleanly:', stopError);
    });
    throw error;
  }
  await recording.stop();
};

const CANVAS_CHANNELS = {
  reasoning: 'mcp_update_reasoning_request',
  mindmap: 'mcp_update_mindmap_request',
};

/**
 * Sends a canvas update to the renderer on the same channel an agent's
 * reasoning_update / mindmap_update MCP call arrives on, so the canvas treats it
 * as agent output ("Live", fresh-node pulse). Nobody waits for the reply.
 */
export const publishAsAgent = async (
  app: ElectronApplication,
  update: { canvas: keyof typeof CANVAS_CHANNELS; taskId: string; data: unknown },
): Promise<void> => {
  await app.evaluate(
    ({ BrowserWindow }, message) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No app window to publish to');
      window.webContents.send(message.channel, {
        reqId: 'showcase',
        taskId: message.taskId,
        update: message.data,
      });
    },
    { channel: CANVAS_CHANNELS[update.canvas], taskId: update.taskId, data: update.data },
  );
};

/**
 * Clicks empty canvas space: a canvas opens with its root selected, which fades
 * every node more than one step away from it.
 */
export const clearCanvasSelection = async (page: Page, canvas: Locator): Promise<void> => {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas is not visible');
  await page.mouse.click(box.x + 30, box.y + box.height * 0.8);
  // Hovering a node dims the rest as well.
  await page.mouse.move(0, 0);
};

/** A task's column in the tiled view, by its demo slug. */
export const taskColumn = (page: Page, slug: string): Locator =>
  page.locator(`[data-task-id="task-${slug}"]`);

/**
 * Sends a follow-up in a chat-view task, as the user would. Its scripted reply
 * (chats.ts) never finishes, so the task then reads as working.
 */
export const sendChatMessage = async (page: Page, slug: string, text: string): Promise<void> => {
  const column = taskColumn(page, slug);
  // The model list fills once the chat has connected; a send before that is refused.
  await expect(column.getByRole('option', { name: 'Sonnet 5' })).toBeAttached();
  const composer = column.getByRole('textbox', { name: 'Message Claude' });
  await composer.fill(text);
  await composer.press('Enter');
  await expect(column.locator('.chat-user-message', { hasText: text })).toBeVisible();
};
