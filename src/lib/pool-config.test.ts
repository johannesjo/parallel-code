import { describe, expect, it } from 'vitest';

import {
  formatNumberMap,
  parseEnvPaths,
  parseNameList,
  parseNumberMap,
  poolFromForm,
  poolToForm,
} from './pool-config';

describe('parseEnvPaths', () => {
  it('takes one path per line, trimming blanks, trailing slashes and duplicates', () => {
    expect(parseEnvPaths('  /projects/MRW1/ \n\n/projects/MRW2\n/projects/MRW1\n')).toEqual([
      '/projects/MRW1',
      '/projects/MRW2',
    ]);
  });
});

describe('parseNameList', () => {
  it('accepts newlines or commas', () => {
    expect(parseNameList('waiter, api\nshared')).toEqual(['waiter', 'api', 'shared']);
  });
});

describe('parseNumberMap', () => {
  it('reads key = number lines', () => {
    expect(parseNumberMap('waiter = 1\nbackoffice=2')).toEqual({ waiter: 1, backoffice: 2 });
  });

  it('keeps a path key that contains no "=" of its own', () => {
    expect(parseNumberMap('/projects/MRW1 = 3500')).toEqual({ '/projects/MRW1': 3500 });
  });

  it('skips comments and malformed lines rather than failing the form', () => {
    expect(parseNumberMap('# a note\nwaiter = abc\n= 5\napi = 0\nok = 7')).toEqual({ ok: 7 });
  });
});

describe('formatNumberMap', () => {
  it('round-trips through the parser', () => {
    const map = { waiter: 1, backoffice: 2 };
    expect(parseNumberMap(formatNumberMap(map))).toEqual(map);
  });
});

describe('poolFromForm', () => {
  it('builds a configuration from the filled form', () => {
    expect(
      poolFromForm({
        envPaths: '/projects/MRW1\n/projects/MRW2',
        members: 'waiter, api',
        portBase: '/projects/MRW1 = 3500',
        portOffsets: 'waiter = 1',
      }),
    ).toEqual({
      envPaths: ['/projects/MRW1', '/projects/MRW2'],
      members: ['waiter', 'api'],
      portBase: { '/projects/MRW1': 3500 },
      portOffsets: { waiter: 1 },
    });
  });

  it('is undefined without an environment, which is how a pool is cleared', () => {
    expect(
      poolFromForm({ envPaths: '  \n', members: 'waiter', portBase: '', portOffsets: '' }),
    ).toBeUndefined();
  });

  it('leaves the optional halves out rather than storing empty ones', () => {
    expect(
      poolFromForm({ envPaths: '/projects/MRW1', members: '', portBase: '', portOffsets: '' }),
    ).toEqual({
      envPaths: ['/projects/MRW1'],
      members: undefined,
      portBase: undefined,
      portOffsets: undefined,
    });
  });
});

describe('poolToForm', () => {
  it('round-trips a configuration through the form', () => {
    const pool = {
      envPaths: ['/projects/MRW1'],
      members: ['waiter'],
      portBase: { '/projects/MRW1': 3500 },
      portOffsets: { waiter: 1 },
    };
    expect(poolFromForm(poolToForm(pool))).toEqual(pool);
  });

  it('gives empty fields for a project with no pool', () => {
    expect(poolToForm(undefined)).toEqual({
      envPaths: '',
      members: '',
      portBase: '',
      portOffsets: '',
    });
  });
});
