import { describe, expect, it } from 'vitest';
import { customAgentId, splitAgentArgs } from './custom-agents';

describe('splitAgentArgs', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(splitAgentArgs('  --model   k2\t--yolo ')).toEqual(['--model', 'k2', '--yolo']);
  });

  it('gives no args for a blank field', () => {
    expect(splitAgentArgs('   ')).toEqual([]);
  });
});

describe('customAgentId', () => {
  it('slugs the name', () => {
    expect(customAgentId('Kimi CLI', [])).toBe('custom-kimi-cli');
  });

  it('does not reuse an id another custom agent has', () => {
    expect(customAgentId('Kimi', ['custom-kimi', 'custom-kimi-2'])).toBe('custom-kimi-3');
  });

  it('falls back when the name has no letters or digits to slug', () => {
    expect(customAgentId('日本', [])).toBe('custom-agent');
  });
});
