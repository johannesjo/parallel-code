import { afterEach, describe, expect, it } from 'vitest';
import { setProjectAgentEnv } from './project-env.js';
import { projectTeardownOptions, setProjectTeardownScript } from './project-teardown.js';

afterEach(() => {
  setProjectTeardownScript('p1', undefined);
  setProjectTeardownScript('p2', undefined);
  setProjectAgentEnv('p1', undefined);
});

describe('project teardown script registry', () => {
  it("gives the project's script with its env, and nothing for other projects", () => {
    setProjectTeardownScript('p1', 'docker compose down');
    setProjectAgentEnv('p1', { COMPOSE_PROJECT_NAME: 'app' });
    expect(projectTeardownOptions('p1')).toEqual({
      teardownScript: 'docker compose down',
      teardownEnv: { COMPOSE_PROJECT_NAME: 'app' },
    });
    expect(projectTeardownOptions('p2')).toEqual({});
  });

  it('clears the script on an empty or missing value', () => {
    setProjectTeardownScript('p1', 'rm -rf .cache');
    setProjectTeardownScript('p1', '  ');
    expect(projectTeardownOptions('p1')).toEqual({});
    setProjectTeardownScript('p2', 'rm -rf .cache');
    setProjectTeardownScript('p2', undefined);
    expect(projectTeardownOptions('p2')).toEqual({});
  });

  it('rejects untrusted input and keeps the previous script', () => {
    setProjectTeardownScript('p1', 'make clean');
    expect(() => setProjectTeardownScript('p1', 42)).toThrow();
    expect(() => setProjectTeardownScript('p1', 'a\0b')).toThrow();
    expect(projectTeardownOptions('p1')).toEqual({ teardownScript: 'make clean', teardownEnv: {} });
  });
});
