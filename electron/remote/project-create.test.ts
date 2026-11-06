import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectFolder } from './project-create.js';

describe('createProjectFolder', () => {
  let parent: string;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-newproj-'));
  });
  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('creates a git repository in a new folder', async () => {
    const created = await createProjectFolder(parent, ' demo ');
    expect(created).toBe(path.join(parent, 'demo'));
    expect(fs.existsSync(path.join(created, '.git'))).toBe(true);
  });

  it('refuses an existing folder, a missing parent and path-like names', async () => {
    fs.mkdirSync(path.join(parent, 'taken'));
    await expect(createProjectFolder(parent, 'taken')).rejects.toThrow('already exists');
    await expect(createProjectFolder(path.join(parent, 'nope'), 'x')).rejects.toThrow('parent');
    await expect(createProjectFolder('relative/dir', 'x')).rejects.toThrow('absolute');
    for (const bad of ['', '..', 'a/b', 'a\\b', 'a\nb'])
      await expect(createProjectFolder(parent, bad)).rejects.toThrow();
  });
});
