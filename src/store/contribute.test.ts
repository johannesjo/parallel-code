import { beforeEach, expect, it, vi } from 'vitest';
import { findParallelCodeProject } from './contribute';
import { resolveGitHubRepository } from './github';
import type { Project } from './types';

vi.mock('./github', () => ({ resolveGitHubRepository: vi.fn() }));

const project = (id: string): Project => ({ id, name: id, path: `/${id}`, color: '#fff' });
const repositories: Record<string, string> = {
  '/app': 'acme/app',
  '/fork': 'JohannesJo/Parallel-Code',
  '/clone': 'johannesjo/parallel-code',
};

beforeEach(() => {
  vi.mocked(resolveGitHubRepository).mockImplementation(async (root) => {
    const repository = repositories[root];
    if (!repository) throw new Error('not a github.com repository');
    return repository;
  });
});

it('picks the first project gh resolves to the upstream repository', async () => {
  const projects = [project('offline'), project('app'), project('fork'), project('clone')];
  await expect(findParallelCodeProject(projects)).resolves.toMatchObject({
    project: { id: 'fork' },
  });
});

it('finds nothing when no project is a checkout of the upstream repository', async () => {
  await expect(findParallelCodeProject([project('app')])).resolves.toEqual({
    project: null,
    lookupError: null,
  });
  await expect(findParallelCodeProject([])).resolves.toEqual({ project: null, lookupError: null });
});

it('ignores a project gh cannot resolve while gh answers for others', async () => {
  await expect(findParallelCodeProject([project('app'), project('offline')])).resolves.toEqual({
    project: null,
    lookupError: null,
  });
});

it('reports gh failing for every project, as the checkout may be among them', async () => {
  await expect(findParallelCodeProject([project('offline'), project('gone')])).resolves.toEqual({
    project: null,
    lookupError: 'not a github.com repository',
  });
});
