import { describe, expect, it } from 'vitest';
import { AGENT_TOUR_LIMITS, parseAgentTourPayload } from './agent-tour.js';
import { TOUR_CARD_LIMITS } from './understanding-limits.js';

const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
const payload = { subject: 'the retry bug', gist: card, cards: [card] };

describe('parseAgentTourPayload', () => {
  it('keeps the shape it was sent and trims the subject', () => {
    expect(parseAgentTourPayload({ ...payload, subject: '  the retry bug  ' })).toEqual(payload);
    expect(parseAgentTourPayload({ ...payload, context: 'The facts.' })).toEqual({
      ...payload,
      context: 'The facts.',
    });
  });

  it('drops an empty context and ignores unknown fields', () => {
    expect(parseAgentTourPayload({ ...payload, context: '   ' })).not.toHaveProperty('context');
    expect(parseAgentTourPayload({ ...payload, view: 'mindmap' })).toEqual(payload);
  });

  it('rejects a payload that is not an object', () => {
    for (const value of [null, 'tour', 42, [payload]])
      expect(() => parseAgentTourPayload(value)).toThrow('must be an object');
  });

  it('rejects a missing, empty or over-long subject', () => {
    for (const subject of [undefined, '', '   ', 7])
      expect(() => parseAgentTourPayload({ ...payload, subject })).toThrow('subject is required.');
    const long = 'x'.repeat(AGENT_TOUR_LIMITS.subject + 1);
    expect(() => parseAgentTourPayload({ ...payload, subject: long })).toThrow(
      `at most ${AGENT_TOUR_LIMITS.subject} characters`,
    );
  });

  it('rejects a gist that is not a card object', () => {
    for (const gist of [undefined, null, 'text', [card]])
      expect(() => parseAgentTourPayload({ ...payload, gist })).toThrow('gist must be an object.');
  });

  it('rejects too few, too many, and non-object cards', () => {
    const bounds = `${TOUR_CARD_LIMITS.minCards} to ${TOUR_CARD_LIMITS.maxCards} cards`;
    expect(() => parseAgentTourPayload({ ...payload, cards: [] })).toThrow(bounds);
    expect(() => parseAgentTourPayload({ ...payload, cards: card })).toThrow(bounds);
    const tooMany = Array.from({ length: TOUR_CARD_LIMITS.maxCards + 1 }, () => card);
    expect(() => parseAgentTourPayload({ ...payload, cards: tooMany })).toThrow(bounds);
    expect(() => parseAgentTourPayload({ ...payload, cards: [card, 'second'] })).toThrow(
      'cards[1] must be an object.',
    );
  });

  it('rejects a context that is not a string or overshoots its cap', () => {
    expect(() => parseAgentTourPayload({ ...payload, context: { text: 'x' } })).toThrow(
      'context must be a string.',
    );
    expect(() =>
      parseAgentTourPayload({ ...payload, context: 'x'.repeat(AGENT_TOUR_LIMITS.context + 1) }),
    ).toThrow(`at most ${AGENT_TOUR_LIMITS.context} characters`);
  });

  it('rejects a payload larger than the serialized cap', () => {
    const fat = { ...card, body: 'x'.repeat(AGENT_TOUR_LIMITS.payloadChars) };
    expect(() => parseAgentTourPayload({ ...payload, cards: [fat] })).toThrow(
      `at most ${AGENT_TOUR_LIMITS.payloadChars} characters`,
    );
  });
});
