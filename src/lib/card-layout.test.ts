import { describe, expect, it } from 'vitest';
import { buildLayoutPrompt, parseLayoutResponse } from './card-layout';

const CONTEXT = {
  description: 'show the commit count',
  checks: [{ id: 'lint', name: 'Lint' }],
  taken: new Set(['commits']),
};

describe('buildLayoutPrompt', () => {
  it('offers the app facts and the checks by id, and prefers them for countable things', () => {
    const prompt = buildLayoutPrompt(CONTEXT.description, CONTEXT.checks);
    expect(prompt).toContain('show the commit count');
    expect(prompt).toContain('commits: Commits on the branch');
    expect(prompt).toContain('lint: Lint');
    expect(prompt).toMatch(/prefer an app fact or a check/i);
  });
});

describe('parseLayoutResponse', () => {
  it('gives an app-fact draft the fact’s own layout and a free id', () => {
    const card = parseLayoutResponse(
      '{"name":"Commits","source":{"kind":"app","fact":"commits"},"slots":[{"id":"x","type":"text","label":"X"}]}',
      CONTEXT,
    );
    expect(card).toEqual({
      id: 'commits-2',
      name: 'Commits',
      description: 'show the commit count',
      source: { kind: 'app', fact: 'commits' },
      slots: [{ id: 'commits', type: 'stat', label: 'Commits' }],
      enabled: true,
    });
  });

  it('gives a check draft the pass/fail layout, and refuses a check the projects lack', () => {
    const card = parseLayoutResponse(
      '{"name":"Lint","source":{"kind":"check","checkId":"lint"}}',
      CONTEXT,
    );
    expect(card.source).toEqual({
      kind: 'check',
      checkId: 'lint',
      mode: 'exit-code',
      trigger: 'finish',
    });
    expect(card.slots).toEqual([{ id: 'result', type: 'status', label: 'Result' }]);
    expect(card.showAtFinish).toBe(true);
    const json = parseLayoutResponse(
      '{"name":"Lint","source":{"kind":"check","checkId":"lint","mode":"json","trigger":"after-turn"}}',
      CONTEXT,
    );
    // A drafted check starts on demand and at Finish, whatever the model asked for.
    expect(json.source).toMatchObject({ mode: 'exit-code', trigger: 'finish' });
    expect(() =>
      parseLayoutResponse('{"name":"T","source":{"kind":"check","checkId":"test"}}', CONTEXT),
    ).toThrow('The draft names a check no project has: "test".');
  });

  it('keeps a model draft’s slots and prompt, with default model and inputs', () => {
    const card = parseLayoutResponse(
      JSON.stringify({
        name: 'Risks',
        source: { kind: 'model', prompt: 'List risks.', trigger: 'nightly' },
        slots: [{ id: 'risks', type: 'items', label: 'Risks', hint: 'Newest first', addUp: true }],
      }),
      CONTEXT,
    );
    expect(card.source).toEqual({
      kind: 'model',
      model: 'default',
      prompt: 'List risks.',
      inputs: ['prompts', 'agent-message', 'diff'],
      trigger: 'after-turn',
    });
    expect(card.slots).toEqual([
      { id: 'risks', type: 'items', label: 'Risks', hint: 'Newest first', addUp: true },
    ]);
  });

  it('refuses a draft with no usable slots or no JSON', () => {
    expect(() =>
      parseLayoutResponse(
        '{"name":"X","source":{"kind":"model","prompt":"p"},"slots":[]}',
        CONTEXT,
      ),
    ).toThrow('The draft has no usable slots.');
    expect(() => parseLayoutResponse('no idea', CONTEXT)).toThrow(
      'The model did not return one JSON object.',
    );
  });
});
