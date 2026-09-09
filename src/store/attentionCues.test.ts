import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { clearTaskGlow, cueTypeFor, mostUrgentCue, pulseTaskGlow, taskGlow } from './attentionCues';

describe('cueTypeFor', () => {
  it('ignores the initial population and unchanged states', () => {
    expect(cueTypeFor(undefined, 'ready')).toBeNull();
    expect(cueTypeFor('ready', 'ready')).toBeNull();
  });

  it('cues only the states a human should react to', () => {
    expect(cueTypeFor('active', 'ready')).toBe('ready');
    expect(cueTypeFor('active', 'needs_input')).toBe('needs_input');
    expect(cueTypeFor('active', 'error')).toBe('error');
    expect(cueTypeFor('ready', 'active')).toBeNull();
    expect(cueTypeFor('active', 'review')).toBeNull();
    expect(cueTypeFor('active', 'idle')).toBeNull();
  });
});

describe('mostUrgentCue', () => {
  it('prefers error over a question over ready', () => {
    expect(mostUrgentCue(['ready', 'error', 'needs_input'])).toBe('error');
    expect(mostUrgentCue(['ready', 'needs_input'])).toBe('needs_input');
    expect(mostUrgentCue(['ready'])).toBe('ready');
    expect(mostUrgentCue([])).toBeNull();
  });
});

describe('task glow signal', () => {
  it('records the latest pulse per task and clears it', () => {
    createRoot((dispose) => {
      pulseTaskGlow('t1', 'ready', 10);
      pulseTaskGlow('t1', 'error', 20);
      expect(taskGlow('t1')).toEqual({ type: 'error', at: 20 });
      expect(taskGlow('t2')).toBeUndefined();

      clearTaskGlow('t1');
      expect(taskGlow('t1')).toBeUndefined();
      dispose();
    });
  });
});
