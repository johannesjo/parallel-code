import { describe, expect, it } from 'vitest';
import { buildCardPrompt, parseCardResponse, type CardPromptInput } from './card-model';
import type { SlotDefinition } from './card-slots';

const SLOTS: SlotDefinition[] = [
  { id: 'risk', type: 'score', label: 'Risk', hint: 'How likely the change breaks something' },
  { id: 'findings', type: 'items', label: 'Findings', addUp: true },
];

function input(over: Partial<CardPromptInput> = {}): CardPromptInput {
  return {
    prompt: 'Rate how risky the change is.',
    slots: SLOTS,
    inputs: ['diff'],
    taskName: 'Retry webhooks',
    prompts: ['add retries'],
    agentMessage: 'Done, retries added.',
    rawDiff: 'diff --git a/q.ts b/q.ts\n@@ -0,0 +1 @@\n+retry()',
    ...over,
  };
}

describe('buildCardPrompt', () => {
  it("starts with the user's prompt, then one line per slot, then the shape", () => {
    const prompt = buildCardPrompt(input());
    expect(prompt.startsWith('Rate how risky the change is.')).toBe(true);
    expect(prompt).toContain('- risk (score): Risk. How likely the change breaks something');
    expect(prompt).toContain('- findings (items, add-up): Findings');
    expect(prompt).toContain('"risk":{"score":0-100,"why":string}');
    expect(prompt.indexOf('- risk (score)')).toBeLessThan(prompt.indexOf('"risk":{'));
    // A list with nothing in it is an answer; a left-out slot is no answer.
    expect(prompt).toContain('a list slot with nothing to list gets []');
  });

  it('sends only the inputs the card chose, fenced as data', () => {
    const prompt = buildCardPrompt(input());
    expect(prompt).toContain('<repo-content>\nChanged files:\nq.ts +1 -0');
    expect(prompt).not.toContain('add retries');
    expect(prompt).not.toContain('Done, retries added.');
    expect(prompt).not.toContain('Retry webhooks');
    const all = buildCardPrompt(input({ inputs: ['task-name', 'prompts', 'agent-message'] }));
    expect(all).toContain('<repo-content>\nRetry webhooks\n</repo-content>');
    expect(all).toContain('<repo-content>\nadd retries\n</repo-content>');
    expect(all).toContain('<repo-content>\nDone, retries added.\n</repo-content>');
    expect(all).not.toContain('q.ts');
  });

  it('always includes the previous values, and says when there are none', () => {
    expect(buildCardPrompt(input())).toContain('(none: this is the first run)');
    const prompt = buildCardPrompt(
      input({ previous: { risk: { type: 'score', score: 40, why: 'small' } } }),
    );
    expect(prompt).toContain('<repo-content>\n{"risk":{"type":"score","score":40,"why":"small"}}');
  });

  it("includes the check's outcome and output tail when the card runs a check", () => {
    const prompt = buildCardPrompt(
      input({ check: { name: 'Lint', status: 'failed', output: 'src/a.ts: no-unused-vars' } }),
    );
    expect(prompt).toContain('## Check "Lint": failed');
    expect(prompt).toContain('<repo-content>\nsrc/a.ts: no-unused-vars\n</repo-content>');
  });

  it('says so when the diff could not be read', () => {
    expect(buildCardPrompt(input({ rawDiff: undefined }))).toContain('could not be read');
  });
});

describe('parseCardResponse', () => {
  it('keeps the slots that validate and drops the rest', () => {
    const values = parseCardResponse(
      SLOTS,
      'Here: {"risk":{"score":140,"why":"x"},"findings":[{"text":"No test","severity":"warn"}]}',
    );
    expect(values).toEqual({
      findings: { type: 'items', items: [{ text: 'No test', severity: 'warn' }] },
    });
  });

  it('throws when no slot validates, so the previous values stay', () => {
    expect(() => parseCardResponse(SLOTS, '{"other":1}')).toThrow(/no usable values/);
    expect(() => parseCardResponse(SLOTS, 'not json')).toThrow();
  });

  it('accepts an empty list as "nothing found", but not a list of junk', () => {
    const risks: SlotDefinition[] = [{ id: 'issues', type: 'items', label: 'Issues' }];
    expect(parseCardResponse(risks, '{"issues":[]}')).toEqual({
      issues: { type: 'items', items: [] },
    });
    expect(() => parseCardResponse(risks, '{"issues":[null, 3]}')).toThrow(/no usable values/);
  });
});
