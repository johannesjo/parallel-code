import { describe, expect, it } from 'vitest';

import { memberPort, poolPortEnv, portVarName } from './pool-ports';
import type { PoolConfig, Task } from '../store/types';

const pool: PoolConfig = {
  envPaths: ['/projects/MRW1', '/projects/MRW2'],
  portBase: { '/projects/MRW1': 3500, '/projects/MRW2': 3510 },
  portOffsets: { waiter: 1, backoffice: 2 },
};

const task = {
  gitIsolation: 'pool',
  envPath: '/projects/MRW2',
  repos: [
    { name: 'waiter', path: '/projects/MRW2/waiter', branchName: 'task/a', baseBranch: 'dev' },
    {
      name: 'backoffice',
      path: '/projects/MRW2/backoffice',
      branchName: 'task/a',
      baseBranch: 'dev',
    },
    { name: 'shared', path: '/projects/MRW2/shared', branchName: 'task/a', baseBranch: 'dev' },
  ],
} satisfies Pick<Task, 'gitIsolation' | 'envPath' | 'repos'>;

describe('memberPort', () => {
  it('adds the member offset to the environment base', () => {
    expect(memberPort(pool, '/projects/MRW1', 'waiter')).toBe(3501);
    expect(memberPort(pool, '/projects/MRW2', 'waiter')).toBe(3511);
  });

  it('is undefined when either half is unconfigured', () => {
    expect(memberPort(pool, '/projects/MRW3', 'waiter')).toBeUndefined();
    expect(memberPort(pool, '/projects/MRW1', 'shared')).toBeUndefined();
  });
});

describe('portVarName', () => {
  it('folds a repo name into a legal shell identifier', () => {
    expect(portVarName('waiter-app')).toBe('PARALLEL_CODE_PORT_WAITER_APP');
    expect(portVarName('report.service')).toBe('PARALLEL_CODE_PORT_REPORT_SERVICE');
  });
});

describe('poolPortEnv', () => {
  it('exports a variable per configured repo and points PORT at the lowest', () => {
    expect(poolPortEnv(pool, task)).toEqual({
      PARALLEL_CODE_PORT_WAITER: '3511',
      PARALLEL_CODE_PORT_BACKOFFICE: '3512',
      PORT: '3511',
      PARALLEL_CODE_ENV_PATH: '/projects/MRW2',
    });
  });

  it('exports nothing when the project configured no ports', () => {
    expect(poolPortEnv({ envPaths: ['/projects/MRW1'] }, task)).toEqual({});
  });

  it('exports nothing for a task that is not a pool task', () => {
    expect(poolPortEnv(pool, { ...task, gitIsolation: 'worktree' })).toEqual({});
  });
});
