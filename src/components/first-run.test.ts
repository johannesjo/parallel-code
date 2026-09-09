import { describe, expect, it } from 'vitest';
import { FIRST_TASK_SUGGESTIONS, detectedAgentsLine } from './first-run';

describe('detectedAgentsLine', () => {
  it('lists the agents that are installed', () => {
    expect(
      detectedAgentsLine([
        { name: 'Claude Code', available: true },
        { name: 'Codex', available: false },
        { name: 'Gemini', available: true },
      ]),
    ).toBe('Detected: Claude Code, Gemini');
  });

  it('points at installation when every agent is missing', () => {
    expect(detectedAgentsLine([{ name: 'Claude Code', available: false }])).toMatch(/Install/);
  });

  it('says nothing before availability has been probed', () => {
    expect(detectedAgentsLine([])).toBeNull();
    expect(detectedAgentsLine([{ name: 'Claude Code' }])).toBeNull();
  });
});

describe('FIRST_TASK_SUGGESTIONS', () => {
  it('ships three distinct, non-empty prompts', () => {
    expect(FIRST_TASK_SUGGESTIONS).toHaveLength(3);
    expect(new Set(FIRST_TASK_SUGGESTIONS.map((s) => s.name)).size).toBe(3);
    for (const s of FIRST_TASK_SUGGESTIONS) expect(s.prompt.length).toBeGreaterThan(40);
  });
});
