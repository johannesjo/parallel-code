import { describe, expect, it } from 'vitest';
import { isServerCommand } from './server-command.js';

describe('isServerCommand', () => {
  // Servers agents started in the background: the first ones are from real
  // Claude Code sessions, the rest common stacks.
  it.each([
    'npx vite --port 5199 --strictPort > $TMPDIR/vite.log 2>&1',
    'npx vite --config electron/vite.config.electron.ts --port 1431 --strictPort',
    'npm run startFrontend -- --port=4277 > $TMPDIR/ng-serve.log 2>&1',
    'npm run dev',
    'pnpm dev',
    'npx ng serve --port 4200',
    'python3 -m http.server 8799 --directory .tmp/angular-dist/browser',
    'cd /home/johannes/www/echo-frog && node scripts/serve.mjs',
    'npx tsc --watch',
    'tail -f log.txt',
    'npm --prefix web run dev',
    'pnpm --filter web dev',
    'pnpm -C apps/site start',
    'npx next dev',
    'npx serve dist',
    'npx webpack serve',
    'uvicorn app:app --reload',
    'flask run',
    'python manage.py runserver',
    'bin/rails s',
    'npx storybook dev -p 6006',
    'docker compose up',
    'sleep infinity',
    'node server.js',
    'npx electron .',
    'npm run electron:dev',
    'npm run test:watch',
    'npm run storybook',
    'npx jest --watchAll',
    'make dev',
    'npx turbo dev',
    'yarn workspace web dev',
    'cargo watch -x run',
    'hugo server',
    'npx live-server',
  ])('treats %s as a server', (command) => {
    expect(isServerCommand(command)).toBe(true);
  });

  // Commands that end on their own, mostly from real sessions.
  it.each([
    'cd /x; PLAYWRIGHT_JSON_OUTPUT_NAME=$PWD/e2e.json npx playwright test --config e2e/playwright.config.ts',
    'npx vitest run',
    'npx vite build',
    'npm run build',
    'npm test',
    'npm ci --no-audit --no-fund',
    'npm install --save-dev prettier',
    'sleep 300',
    'timeout 1500 gh pr checks 10663 --watch --interval 60 2>&1 | tail -25',
    'gh run watch 41031993064 --compact --exit-status -i 20 2>&1 | tail',
    'npm run test:serve',
    'npx vitest run src/serve/handler.test.ts',
    'docker compose up -d',
    'npm run devtools-check',
    'node scripts/server-check.js',
    'npx vitest run --config vite.config.ts',
    'cd ~/www/vite-app && npx playwright test',
    'npx vite-node scripts/migrate.ts',
    'cd server && npm test',
    'pytest tests/server',
    'cargo test -p server',
    'npm test -- --watch=false',
    'npx vitest --watch false',
    'npm run build:dev',
    'pnpm run test:dev',
    'npm run dev:build',
    'npm run start:e2e',
  ])('treats %s as a command that finishes', (command) => {
    expect(isServerCommand(command)).toBe(false);
  });
});
