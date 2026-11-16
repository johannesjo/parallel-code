import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_MODELS } from '../../electron/shared/task-name-model';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('./check-suite-state', () => ({
  getProjectChecks: (projectId: string) =>
    projectId === 'p1'
      ? [{ id: 'lint', name: 'Lint', kind: 'static', command: 'npm run lint' }]
      : [],
}));

import { setStore } from './core';
import { draftCard } from './card-layout';

beforeEach(() => {
  mockRequest.mockReset();
  setStore('briefModel', 'haiku' as never);
  setStore('projects', [
    { id: 'p1', name: 'One', path: '/one' },
    { id: 'p2', name: 'Two', path: '/two' },
  ] as never);
  setStore('cardDefinitions', []);
});

describe('draftCard', () => {
  it('asks the default model for a layout from the description and the projects’ checks only', async () => {
    mockRequest.mockReturnValue({
      result: Promise.resolve('{"name":"Lint","source":{"kind":"check","checkId":"lint"}}'),
      cancel: vi.fn(),
    });
    const card = await draftCard('  is lint clean?  ');
    expect(card).toMatchObject({ id: 'lint', description: 'is lint clean?' });
    const options = mockRequest.mock.calls[0][0];
    expect(options).toMatchObject({
      purpose: 'card-layout',
      cwd: '/one',
      settings: BRIEF_MODELS.haiku,
      projectId: undefined,
    });
    expect(options.prompt).toContain('- lint: Lint');
  });

  it('refuses an empty description, or no project to run in, without a request', async () => {
    await expect(draftCard('  ')).rejects.toThrow('Describe the card first.');
    setStore('projects', []);
    await expect(draftCard('lint')).rejects.toThrow('Add a project first.');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
