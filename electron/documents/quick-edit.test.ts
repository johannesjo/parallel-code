import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  convertQuickEdit,
  onQuickEditWarning,
  openQuickEdit,
  stopAllQuickEditSyncs,
  stopQuickEditSync,
} from './quick-edit.js';

const made: string[] = [];

function tmpFolder(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-quickedit-')));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

/** A code repository with one committed spec and some unrelated work in progress. */
function codeRepo(): { repo: string; spec: string } {
  const repo = tmpFolder();
  initRepo(repo);
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export {};\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export const wip = 1;\n');
  return { repo, spec: path.join(repo, 'docs', 'spec.md') };
}

/** Sync tests wait on real 700 ms polls after git setup; a loaded run needs more than the default. */
const POLL_TEST_MS = 20_000;

afterEach(() => {
  stopAllQuickEditSyncs();
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

describe('openQuickEdit', () => {
  it('works on a committed copy and commits nothing where the file lives', async () => {
    const { repo, spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);

    expect(target.projectRoot.startsWith(path.join(data, 'quick-edits'))).toBe(true);
    expect(target.documentPath).toBe('spec.md');
    expect(git(target.projectRoot, 'show', 'HEAD:spec.md')).toBe('# Spec\n');
    expect(git(repo, 'log', '--format=%s')).toBe('init\n');
    expect(git(repo, 'status', '--porcelain')).toBe(' M index.ts\n');
  });

  it('reopens the same copy and brings it up to date with the original', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const first = await openQuickEdit(data, spec);
    stopAllQuickEditSyncs();
    fs.writeFileSync(spec, '# Spec\n\nEdited elsewhere.\n');

    const second = await openQuickEdit(data, spec);
    expect(second.projectRoot).toBe(first.projectRoot);
    expect(fs.readFileSync(path.join(second.projectRoot, 'spec.md'), 'utf8')).toBe(
      '# Spec\n\nEdited elsewhere.\n',
    );
  });

  it(
    'keeps the original and the copy in step both ways',
    async () => {
      const { spec } = codeRepo();
      const target = await openQuickEdit(tmpFolder(), spec);
      const copy = path.join(target.projectRoot, target.documentPath);

      fs.writeFileSync(copy, '# Spec\n\nAccepted proposal.\n');
      await vi.waitFor(
        () => expect(fs.readFileSync(spec, 'utf8')).toContain('Accepted proposal.'),
        {
          timeout: 5000,
        },
      );
      fs.writeFileSync(spec, '# Spec\n\nTyped in an editor.\n');
      await vi.waitFor(
        () => expect(fs.readFileSync(copy, 'utf8')).toContain('Typed in an editor.'),
        {
          timeout: 5000,
        },
      );
    },
    POLL_TEST_MS,
  );

  it(
    'does not bring back an original that was deleted',
    async () => {
      const { spec } = codeRepo();
      const target = await openQuickEdit(tmpFolder(), spec);
      fs.rmSync(spec);
      fs.writeFileSync(path.join(target.projectRoot, target.documentPath), '# Changed\n');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(fs.existsSync(spec)).toBe(false);
    },
    POLL_TEST_MS,
  );

  it('keeps copy edits that had not synced yet when the file is reopened', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    const copy = path.join(target.projectRoot, 'spec.md');
    // The app quit before the poll wrote the accepted proposal back.
    stopAllQuickEditSyncs();
    fs.writeFileSync(copy, '# Spec\n\nAccepted proposal.\n');

    await openQuickEdit(data, spec);
    expect(fs.readFileSync(copy, 'utf8')).toContain('Accepted proposal.');
    expect(fs.readFileSync(spec, 'utf8')).toContain('Accepted proposal.');
  });

  it('lets the original win when both sides changed since the last sync', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    const copy = path.join(target.projectRoot, 'spec.md');
    stopAllQuickEditSyncs();
    fs.writeFileSync(copy, '# Spec\n\nFrom the copy.\n');
    fs.writeFileSync(spec, '# Spec\n\nFrom an editor.\n');

    await openQuickEdit(data, spec);
    expect(fs.readFileSync(copy, 'utf8')).toContain('From an editor.');
  });

  it('copies bytes that are not UTF-8 unchanged', async () => {
    const { repo } = codeRepo();
    const latin1 = path.join(repo, 'docs', 'latin1.md');
    const bytes = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
    fs.writeFileSync(latin1, bytes);
    const target = await openQuickEdit(tmpFolder(), latin1);
    expect(fs.readFileSync(path.join(target.projectRoot, 'latin1.md')).equals(bytes)).toBe(true);
  });

  it(
    'stops syncing a quick edit that was removed',
    async () => {
      const { spec } = codeRepo();
      const target = await openQuickEdit(tmpFolder(), spec);
      stopQuickEditSync(target.projectRoot);
      fs.writeFileSync(path.join(target.projectRoot, 'spec.md'), '# Changed\n');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(fs.readFileSync(spec, 'utf8')).toBe('# Spec\n');
    },
    POLL_TEST_MS,
  );

  it('refuses a document name that links to a file that is not a document', async () => {
    const { repo } = codeRepo();
    const secret = path.join(repo, 'settings.conf');
    fs.writeFileSync(secret, 'token=1\n');
    fs.symlinkSync(secret, path.join(repo, 'docs', 'notes.md'));
    await expect(openQuickEdit(tmpFolder(), path.join(repo, 'docs', 'notes.md'))).rejects.toThrow(
      'Markdown and HTML',
    );
  });

  it('keeps every losing copy beside it when both sides changed, and says where', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    const conflict = async (copyText: string, originalText: string) => {
      stopAllQuickEditSyncs();
      fs.writeFileSync(path.join(target.projectRoot, 'spec.md'), copyText);
      fs.writeFileSync(spec, originalText);
      return (await openQuickEdit(data, spec)).warning;
    };

    const first = await conflict('# Spec\n\nFrom the copy.\n', '# Spec\n\nFrom an editor.\n');
    const second = await conflict('# Spec\n\nCopy again.\n', '# Spec\n\nEditor again.\n');
    const kept = fs
      .readdirSync(path.dirname(target.projectRoot))
      .filter((f) => f.startsWith(`${path.basename(target.projectRoot)}.conflict`))
      .map((f) => fs.readFileSync(path.join(path.dirname(target.projectRoot), f), 'utf8'));
    expect(kept.sort()).toEqual(['# Spec\n\nCopy again.\n', '# Spec\n\nFrom the copy.\n']);
    expect(first).toContain('.conflict');
    expect(second).not.toBe(first);
  });

  it('tells the app about a clash found while it is running, not only at open', async () => {
    const { spec } = codeRepo();
    const target = await openQuickEdit(tmpFolder(), spec);
    const heard = vi.fn();
    onQuickEditWarning(heard);
    fs.writeFileSync(path.join(target.projectRoot, 'spec.md'), '# Spec\n\nFrom the copy.\n');
    fs.writeFileSync(spec, '# Spec\n\nFrom an editor.\n');
    stopQuickEditSync(target.projectRoot);
    expect(heard).toHaveBeenCalledWith({
      sourcePath: spec,
      message: expect.stringContaining('.conflict'),
    });
    onQuickEditWarning(() => {});
  });

  it('reports a failing sync once until it works again, even as the error changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { spec } = codeRepo();
    const target = await openQuickEdit(tmpFolder(), spec);
    const record = `${target.projectRoot}.synced`;
    const heard = vi.fn();
    onQuickEditWarning(heard);
    const unreadable = () => fs.chmodSync(spec, 0o000);
    const readable = () => fs.chmodSync(spec, 0o644);
    const recordIsFolder = () => {
      fs.rmSync(record);
      fs.mkdirSync(record);
    };
    const recordIsFile = () => {
      fs.rmdirSync(record);
      fs.writeFileSync(record, '# Spec\n');
    };
    try {
      unreadable();
      vi.advanceTimersByTime(700);
      readable();
      recordIsFolder();
      vi.advanceTimersByTime(700);
      recordIsFile();
      unreadable();
      vi.advanceTimersByTime(700);
      expect(heard).toHaveBeenCalledTimes(1);
      readable();
      vi.advanceTimersByTime(700);
      unreadable();
      vi.advanceTimersByTime(700);
      expect(heard).toHaveBeenCalledTimes(2);
    } finally {
      readable();
      onQuickEditWarning(() => {});
      vi.useRealTimers();
    }
  });

  it(
    'writes the original in place, so hard links to it see the edit',
    async () => {
      const { repo, spec } = codeRepo();
      const linked = path.join(repo, 'linked.md');
      fs.linkSync(spec, linked);
      const target = await openQuickEdit(tmpFolder(), spec);
      fs.writeFileSync(path.join(target.projectRoot, 'spec.md'), '# Spec\n\nVia the copy.\n');
      await vi.waitFor(() => expect(fs.readFileSync(spec, 'utf8')).toContain('Via the copy.'), {
        timeout: POLL_TEST_MS / 2,
      });
      expect(fs.readFileSync(linked, 'utf8')).toContain('Via the copy.');
    },
    POLL_TEST_MS,
  );

  it(
    'leaves a copy that git is replacing alone between polls',
    async () => {
      const { spec } = codeRepo();
      const target = await openQuickEdit(tmpFolder(), spec);
      const copy = path.join(target.projectRoot, 'spec.md');
      fs.rmSync(copy);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(fs.existsSync(copy)).toBe(false);
    },
    POLL_TEST_MS,
  );

  it('creates a missing file only when asked to', async () => {
    const { repo } = codeRepo();
    const data = tmpFolder();
    const fresh = path.join(repo, 'docs', 'new-idea.md');
    await expect(openQuickEdit(data, fresh)).rejects.toThrow('does not exist');
    await openQuickEdit(data, fresh, true);
    expect(fs.readFileSync(fresh, 'utf8')).toBe('# New idea\n\n');
  });

  it('refuses files that are not documents', async () => {
    const { repo } = codeRepo();
    await expect(openQuickEdit(tmpFolder(), path.join(repo, 'index.ts'))).rejects.toThrow(
      'Markdown and HTML',
    );
  });
});

describe('convertQuickEdit', () => {
  it('copies the document into a new project folder and leaves the original', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    fs.writeFileSync(path.join(target.projectRoot, 'spec.md'), '# Spec\n\nDraft.\n');
    const folder = path.join(tmpFolder(), 'spec-project');

    const setup = await convertQuickEdit(data, target.projectRoot, 'spec.md', folder);
    expect(setup.documentPath).toBe('spec.md');
    expect(git(folder, 'show', 'HEAD:spec.md')).toBe('# Spec\n\nDraft.\n');
    expect(fs.existsSync(spec)).toBe(true);
  });

  it('brings along an edit to the original that no poll has seen yet', async () => {
    const { spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    fs.writeFileSync(spec, '# Spec\n\nJust saved in an editor.\n');
    const folder = path.join(tmpFolder(), 'spec-project');

    await convertQuickEdit(data, target.projectRoot, 'spec.md', folder);
    expect(fs.readFileSync(path.join(folder, 'spec.md'), 'utf8')).toContain('Just saved');
  });

  it('refuses a folder inside a repository before writing anything', async () => {
    const { repo, spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);
    const inside = path.join(repo, 'notes');

    await expect(convertQuickEdit(data, target.projectRoot, 'spec.md', inside)).rejects.toThrow(
      'inside the Git repository',
    );
    expect(fs.existsSync(inside)).toBe(false);
  });

  it('refuses a code repository as the new home', async () => {
    const { repo, spec } = codeRepo();
    const data = tmpFolder();
    const target = await openQuickEdit(data, spec);

    await expect(convertQuickEdit(data, target.projectRoot, 'spec.md', repo)).rejects.toThrow(
      'holds code',
    );
    expect(fs.existsSync(path.join(repo, 'spec.md'))).toBe(false);
  });

  it('refuses the quick-edit folder itself as a root', async () => {
    const data = tmpFolder();
    await openQuickEdit(data, codeRepo().spec);
    await expect(
      convertQuickEdit(
        data,
        path.join(data, 'quick-edits'),
        'spec.md',
        path.join(tmpFolder(), 'x'),
      ),
    ).rejects.toThrow('not a quick edit');
  });

  it('refuses a root that is not one of its quick edits', async () => {
    const { repo } = codeRepo();
    await expect(
      convertQuickEdit(tmpFolder(), repo, 'docs/spec.md', path.join(tmpFolder(), 'x')),
    ).rejects.toThrow('not a quick edit');
  });
});
