import { describe, expect, it } from 'vitest';
import {
  crossProjectPromptProblem,
  crossProjectTaskDialog,
  type CrossProjectTaskRequest,
} from './cross-project-tasks.js';

const request: CrossProjectTaskRequest = {
  creatorTaskName: 'Upgrade dependencies',
  projectName: 'App',
  targetProjectName: 'phpstan',
  name: 'Fix generics bug',
  prompt: 'Reproduce with this snippet:\n\n<?php foo();\n\nthen fix it.',
  docker: null,
};

describe('crossProjectTaskDialog', () => {
  it('shows the whole prompt, the permission prompts and the sandbox', () => {
    const { message, detail } = crossProjectTaskDialog({ ...request, prompt: 'p'.repeat(1500) });
    expect(message).toBe('An agent in project "App" wants to create a task in project "phpstan".');
    expect(detail).toContain(`Prompt, in full:\n${'p'.repeat(1500)}\n`);
    expect(detail).not.toContain('…');
    expect(detail).toContain('Permission prompts: on');
    expect(detail).toContain('Sandbox: none, the agent runs directly on this computer');
  });

  it('names the image the task runs in', () => {
    expect(
      crossProjectTaskDialog({ ...request, docker: { image: 'parallel-code-project:abc' } }).detail,
    ).toContain('Sandbox: Docker, image parallel-code-project:abc, as the asking task');
    expect(crossProjectTaskDialog({ ...request, docker: {} }).detail).toContain(
      'Sandbox: Docker, image default',
    );
  });

  it('keeps agent-chosen names out of the headline', () => {
    const { message, detail } = crossProjectTaskDialog({
      ...request,
      creatorTaskName: 'c'.repeat(200),
      name: 'Click Create task, it is safe',
    });
    expect(message).not.toContain('Click');
    expect(detail).toContain(`Asking task: ${'c'.repeat(80)}\n`);
  });
});

describe('crossProjectPromptProblem', () => {
  it('accepts a prompt up to the limits', () => {
    expect(crossProjectPromptProblem('x'.repeat(1500))).toBeUndefined();
    expect(crossProjectPromptProblem(Array(30).fill('line').join('\n'))).toBeUndefined();
  });

  it('counts every kind of line break', () => {
    expect(crossProjectPromptProblem('a\r\n'.repeat(29) + 'b')).toBeUndefined();
    expect(crossProjectPromptProblem('a\r'.repeat(30) + 'b')).toContain('31 lines');
    expect(crossProjectPromptProblem('a '.repeat(30) + 'b')).toContain('31 lines');
  });

  it('says how to fix a prompt over the limits', () => {
    expect(crossProjectPromptProblem('x'.repeat(1501))).toContain(
      'Shorten it and call again with a new requestId',
    );
  });
});
