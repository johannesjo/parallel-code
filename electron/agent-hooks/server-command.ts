/** Commands that run until stopped: dev servers, static file servers, watchers. */
const SERVER_PATTERNS: readonly RegExp[] = [
  // `vite` as the program, not `vite.config.ts` or `vite-node`; `vite build` ends.
  /(?:^|[\s/])vite(?=\s|$)(?!\s+build\b)/,
  // Script names like `dev`, `test:watch`, or `startFrontend`, after flags such
  // as `--prefix web` or a `yarn workspace web`. Names that only start that way,
  // like `dev:build` or `start:e2e`, are often finite runs.
  /\b(?:npm|pnpm|yarn|bun)(?:\s+-{1,2}\w[\w-]*(?:[=\s]+[^-\s]\S*)?)*(?:\s+workspace\s+\S+)?\s+(?:run\s+)?(?:(?:(?!build|test)[\w-]+:)?dev|(?:[\w-]+:)?watch|start|serve|preview|storybook)(?:[A-Z]\w*)?(?=\s|$)/,
  // `serve`/`server` as the program or its script, not a directory like `cd server`.
  /(?:^|[;&|]\s*|\b(?:npx|bunx|node|ng|webpack|hugo)\s+(?:\S+\/)?)server?(?:\.m?[jt]s)?(?=\s|$)/,
  /\b(?:next|nuxt|astro|storybook|make|turbo)\s+(?:run\s+)?dev\b/,
  /\b(?:http|live)[.-]server\b/,
  /\belectron\s+\.(?=\s|$)/,
  /\bcargo\s+watch\b/,
  /\buvicorn\b|\bflask\s+run\b|\brunserver\b|\brails\s+s(?:erver)?\b/,
  /\bcompose\s+up\b(?!.*\s(?:-d|--detach)\b)/,
  /\bnodemon\b/,
  /\btail\s+-[fF]\b/,
  /\bsleep\s+infinity\b/,
];

/** `gh pr checks --watch` and `gh run watch` end once CI does. */
const WATCH_FLAG = /(?:^|\s)--watch(?:All)?(?=\s|$)(?!\s+false\b)/;
const GH = /\bgh\s/;

/**
 * True when a background shell command looks like it never ends on its own.
 * Agents start such servers to check their work and often leave them running,
 * so a task must not stay `working` for them.
 *
 * shortcut: matches the command text — a miss leaves the task working with the
 * command named on its card; check for a listening port if misses matter.
 */
export function isServerCommand(command: string): boolean {
  if (SERVER_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return WATCH_FLAG.test(command) && !GH.test(command);
}
