import { describe, expect, it } from 'vitest';
import { getSkipPermissionsArgs } from './agents.js';

describe('getSkipPermissionsArgs', () => {
  it('returns a copy of default skip-permission args', () => {
    const first = getSkipPermissionsArgs('claude');
    first.push('--mutated');

    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
  });

  it('returns Kimi Code skip-permission args', () => {
    expect(getSkipPermissionsArgs('kimi')).toEqual(['--yolo']);
  });
});
