import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KANBAN_FILE, readKanbanBoard, writeKanbanBoard } from './kanban.js';

let project: string;
let outside: string;
const board = () => path.join(project, KANBAN_FILE);

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-project-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-outside-')));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('kanban board file', () => {
  it('reads null when the project has no board', () => {
    expect(readKanbanBoard(project)).toBeNull();
  });

  it('creates the board, then replaces it only while it holds the expected text', () => {
    writeKanbanBoard(project, '# One\n', null);
    expect(readKanbanBoard(project)).toBe('# One\n');
    writeKanbanBoard(project, '# Two\n', '# One\n');
    expect(readKanbanBoard(project)).toBe('# Two\n');
  });

  it('never overwrites an edit made since the last read', () => {
    writeKanbanBoard(project, '# One\n', null);
    fs.writeFileSync(board(), '# Edited elsewhere\n');
    expect(() => writeKanbanBoard(project, '# Two\n', '# One\n')).toThrow(/changed on disk/);
    expect(() => writeKanbanBoard(project, '# Two\n', null)).toThrow(/changed on disk/);
    expect(fs.readFileSync(board(), 'utf8')).toBe('# Edited elsewhere\n');
  });

  it('does not recreate a board deleted since the last read', () => {
    expect(() => writeKanbanBoard(project, '# Two\n', '# One\n')).toThrow(/changed on disk/);
    expect(fs.existsSync(board())).toBe(false);
  });

  it('never follows a symlinked board out of the project', () => {
    const target = path.join(outside, 'secret.md');
    fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, board());
    expect(() => readKanbanBoard(project)).toThrow(/not a regular file/);
    expect(() => writeKanbanBoard(project, 'x', 'secret')).toThrow(/not a regular file/);
    expect(fs.readFileSync(target, 'utf8')).toBe('secret');
  });

  it('validates its inputs before touching the disk', () => {
    expect(() => readKanbanBoard('relative/path')).toThrow(/absolute/);
    expect(() => readKanbanBoard(`${project}/../x`)).toThrow(/\.\./);
    expect(() => writeKanbanBoard(project, 42, null)).toThrow(/content/);
    expect(() => writeKanbanBoard(project, 'x', 42)).toThrow(/expected/);
    expect(() => writeKanbanBoard(project, 'x'.repeat(1024 * 1024 + 1), null)).toThrow(/too large/);
    expect(fs.existsSync(board())).toBe(false);
  });
});
