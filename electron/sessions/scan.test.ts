import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { clearSessionCache, listSessionsForCwd } from './scan.js';
import { claudeProjectSlug } from './transcripts.js';

const CWD = '/home/u/www/proj/.worktrees/task/alpha-1111';
const OTHER_CWD = '/home/u/www/proj/.worktrees/task/beta-2222';

// UUID-shaped, because a session id that is not gets rejected on the way in —
// it would otherwise reach a spawned CLI's argv. Claude writes v4, Codex v7.
const ID_A = 'aaaa1111-0000-4000-8000-000000000001';
const ID_B = 'bbbb2222-0000-7000-8000-000000000002';
const ID_C = 'cccc3333-0000-4000-8000-000000000003';
const ID_D = 'dddd4444-0000-7000-8000-000000000004';
const ID_E = 'eeee5555-0000-4000-8000-000000000005';
const ID_F = 'ffff6666-0000-4000-8000-000000000006';
const ID_KEEP = '11111111-0000-7000-8000-000000000009';
const ID_OLD = '22222222-0000-7000-8000-000000000010';

let root: string;
let claudeRoot: string;
let codexRoot: string;

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

async function writeClaude(cwd: string, id: string, extra: unknown[] = []): Promise<string> {
  const dir = path.join(claudeRoot, claudeProjectSlug(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(
    file,
    jsonl([
      {
        type: 'user',
        sessionId: id,
        cwd,
        gitBranch: 'task/alpha',
        timestamp: '2026-01-01T00:00:00Z',
      },
      ...extra,
    ]),
  );
  return file;
}

async function writeCodex(
  cwd: string,
  id: string,
  day = '01',
  extra: unknown[] = [],
): Promise<string> {
  const dir = path.join(codexRoot, '2026', '01', day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-${day}T10-00-00-${id}.jsonl`);
  await fs.writeFile(
    file,
    jsonl([
      {
        type: 'session_meta',
        payload: { id, cwd, timestamp: '2026-01-01T10:00:00Z', git: { branch: 'task/alpha' } },
      },
      ...extra,
    ]),
  );
  return file;
}

/** A Codex user turn as the CLI records it. */
function codexUserTurn(text: string): unknown {
  return { type: 'response_item', payload: { role: 'user', content: [{ text }] } };
}

function padding(count: number, sessionId: string): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant',
    sessionId,
    cwd: CWD,
    pad: `${'x'.repeat(200)}${i}`,
  }));
}

beforeEach(async () => {
  clearSessionCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-sessions-'));
  claudeRoot = path.join(root, 'claude', 'projects');
  codexRoot = path.join(root, 'codex', 'sessions');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function scan(cwd = CWD) {
  return listSessionsForCwd(cwd, { claudeRoot, codexRoot });
}

describe('listSessionsForCwd', () => {
  it('returns nothing when neither root exists', async () => {
    await expect(scan()).resolves.toEqual([]);
  });

  it('finds a Claude session for the worktree', async () => {
    await writeClaude(CWD, ID_A, [{ type: 'ai-title', aiTitle: 'Fix the parser' }]);
    const [session] = await scan();
    expect(session).toMatchObject({
      id: ID_A,
      agent: 'claude',
      cwd: CWD,
      title: 'Fix the parser',
    });
  });

  it('finds a Codex session for the worktree', async () => {
    await writeCodex(CWD, ID_B);
    const [session] = await scan();
    expect(session).toMatchObject({ id: ID_B, agent: 'codex', cwd: CWD });
  });

  // The whole point of re-reading cwd from the body: another worktree's
  // transcripts must never be offered as this one's.
  it('excludes sessions belonging to another worktree', async () => {
    await writeClaude(OTHER_CWD, ID_C);
    await writeCodex(OTHER_CWD, ID_D);
    await expect(scan()).resolves.toEqual([]);
  });

  // A stale directory whose transcripts state a different cwd must not leak in
  // even though the slug lookup landed on it.
  it('ignores a Claude transcript filed under our slug but stating another cwd', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${ID_E}.jsonl`),
      jsonl([{ type: 'user', sessionId: ID_E, cwd: OTHER_CWD }]),
    );
    await expect(scan()).resolves.toEqual([]);
  });

  it('sorts newest first across both agents', async () => {
    const older = await writeClaude(CWD, ID_A);
    const newer = await writeCodex(CWD, ID_B);
    await fs.utimes(older, new Date(1_000_000), new Date(1_000_000));
    await fs.utimes(newer, new Date(2_000_000), new Date(2_000_000));
    const sessions = await scan();
    expect(sessions.map((s) => s.id)).toEqual([ID_B, ID_A]);
  });

  it('caps how many Codex files it opens', async () => {
    await writeCodex(CWD, ID_KEEP, '09');
    await writeCodex(CWD, ID_OLD, '01');
    // One file of budget, and the newest day is walked first.
    const sessions = await listSessionsForCwd(CWD, { claudeRoot, codexRoot, maxCodexFiles: 1 });
    expect(sessions.map((s) => s.id)).toEqual([ID_KEEP]);
  });

  it('skips an unparseable transcript without losing its neighbours', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'broken.jsonl'), 'not json at all\n{"also": bad}\n');
    await writeClaude(CWD, ID_A);
    const sessions = await scan();
    expect(sessions.map((s) => s.id)).toEqual([ID_A]);
  });

  it('ignores non-transcript files', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(path.join(dir, ID_A), { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
    await expect(scan()).resolves.toEqual([]);
  });

  // Files larger than the two chunks are read head-and-tail; the title Claude
  // appends late in a long session still has to come back.
  it('reads the tail of a transcript too large to read whole', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${ID_F}.jsonl`),
      jsonl([
        { type: 'user', sessionId: ID_F, cwd: CWD },
        ...padding(4000, ID_F),
        { type: 'ai-title', aiTitle: 'Title written late' },
      ]),
    );
    const [session] = await scan();
    expect(session?.title).toBe('Title written late');
  });

  it('re-reads a transcript after it changes', async () => {
    const file = await writeClaude(CWD, ID_A, [{ type: 'ai-title', aiTitle: 'First' }]);
    expect((await scan())[0]?.title).toBe('First');
    await fs.writeFile(
      file,
      jsonl([
        { type: 'user', sessionId: ID_A, cwd: CWD },
        { type: 'ai-title', aiTitle: 'Second' },
      ]),
    );
    await fs.utimes(file, new Date(3_000_000), new Date(3_000_000));
    expect((await scan())[0]?.title).toBe('Second');
  });

  it('bounds both caches and reuses records and titles that remain cached', async () => {
    await Promise.all(
      Array.from({ length: 801 }, (_, index) =>
        writeCodex(CWD, `${index.toString(16).padStart(8, '0')}-0000-7000-8000-000000000001`),
      ),
    );
    const options = { claudeRoot, codexRoot, maxCodexFiles: 801 };
    const open = vi.spyOn(fs, 'open');
    expect(await listSessionsForCwd(CWD, options)).toHaveLength(801);

    open.mockClear();
    // The first file scanned was evicted from both FIFO caches after file 801.
    expect(await listSessionsForCwd(CWD, { ...options, maxCodexFiles: 1 })).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(2);

    open.mockClear();
    expect(await listSessionsForCwd(CWD, { ...options, maxCodexFiles: 1 })).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('evicts stale records and titles when a transcript stat fails', async () => {
    const file = await writeCodex(CWD, ID_B, '01', [codexUserTurn('Original title')]);
    const timestamp = new Date(1_000_000);
    await fs.utimes(file, timestamp, timestamp);
    expect((await scan())[0]?.title).toBe('Original title');

    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('transcript disappeared'));
    await expect(scan()).resolves.toEqual([]);
    stat.mockRestore();

    await fs.writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { id: ID_D, cwd: CWD } },
        codexUserTurn('Replacement title'),
      ]),
    );
    // A recreated transcript can have the old mtime; neither cached value applies.
    await fs.utimes(file, timestamp, timestamp);
    expect((await scan())[0]).toMatchObject({ id: ID_D, title: 'Replacement title' });
  });

  // Codex buries the user's first words behind a few hundred KB of injected
  // preamble, well past the window the record itself is read from. Without the
  // deeper title read every row in the picker reads "Session <8 hex>".
  it('finds a Codex title that sits beyond the record read window', async () => {
    await writeCodex(CWD, ID_B, '01', [
      ...padding(600, ID_B),
      codexUserTurn('the real opening ask'),
      ...padding(600, ID_B),
    ]);
    const [session] = await scan();
    expect(session?.title).toBe('the real opening ask');
  });

  // The record read sees only the head and tail, so on a long session the
  // earliest user turn *it* can see is a late one. The deeper read must win.
  it('prefers the true opening turn over a later one visible in the tail', async () => {
    await writeCodex(CWD, ID_B, '01', [
      ...padding(600, ID_B),
      codexUserTurn('the real opening ask'),
      ...padding(600, ID_B),
      codexUserTurn('a much later follow-up'),
    ]);
    const [session] = await scan();
    expect(session?.title).toBe('the real opening ask');
  });
});

// A session id is read off disk and then handed to a spawned CLI as an
// argument. `claude --resume` takes an optional argument and `codex resume` a
// positional, so a value starting with a dash becomes a flag in its own right.
describe('session id validation', () => {
  it('drops a Codex session whose id is not a session id', async () => {
    const dir = path.join(codexRoot, '2026', '01', '01');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'rollout-2026-01-01T10-00-00-evil.jsonl'),
      jsonl([
        {
          type: 'session_meta',
          payload: { id: '--dangerously-bypass-approvals-and-sandbox', cwd: CWD },
        },
      ]),
    );
    await expect(scan()).resolves.toEqual([]);
  });

  it('drops a Claude session whose id is not a session id', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'session.jsonl'),
      jsonl([{ type: 'user', sessionId: '--dangerously-skip-permissions', cwd: CWD }]),
    );
    await expect(scan()).resolves.toEqual([]);
  });

  // The filename is the fallback when no entry carries an id, so it needs the
  // same check as the body.
  it('drops a Claude session named after a flag', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, '--dangerously-skip-permissions.jsonl'),
      jsonl([{ type: 'user', cwd: CWD }]),
    );
    await expect(scan()).resolves.toEqual([]);
  });

  // A body id that fails the check must not fall through to a filename that
  // passes it — and vice versa, the good one of the pair should win.
  it('falls back to a valid filename when the body id is rejected', async () => {
    const dir = path.join(claudeRoot, claudeProjectSlug(CWD));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${ID_A}.jsonl`),
      jsonl([{ type: 'user', sessionId: '-rf', cwd: CWD }]),
    );
    const [session] = await scan();
    expect(session?.id).toBe(ID_A);
  });
});
