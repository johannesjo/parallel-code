import { describe, expect, it } from 'vitest';
import { parseCardConfigChange } from './card-config.js';

describe('parseCardConfigChange', () => {
  it('passes a save through with its card and position, dropping anything else', () => {
    const card = { id: 'risks', name: 'Risks' };
    expect(parseCardConfigChange({ action: 'save', card, position: 2, taskId: 'other' })).toEqual({
      action: 'save',
      card,
      position: 2,
    });
    expect(parseCardConfigChange({ action: 'save', card })).toEqual({ action: 'save', card });
  });

  it('rejects a save without a card object or with a position that is no index', () => {
    expect(() => parseCardConfigChange({ action: 'save', card: 'risks' })).toThrow('"card"');
    expect(() => parseCardConfigChange({ action: 'save', card: {}, position: -1 })).toThrow(
      '"position"',
    );
    expect(() => parseCardConfigChange({ action: 'save', card: {}, position: 1.5 })).toThrow(
      '"position"',
    );
  });

  it('passes a remove through with the card id only', () => {
    expect(parseCardConfigChange({ action: 'remove', card: 'risks', position: 1 })).toEqual({
      action: 'remove',
      card: 'risks',
    });
  });

  it('rejects a remove without a card id, and any other action', () => {
    expect(() => parseCardConfigChange({ action: 'remove', card: 'My Risks' })).toThrow('card id');
    expect(() => parseCardConfigChange({ action: 'remove', card: { id: 'risks' } })).toThrow(
      'card id',
    );
    expect(() => parseCardConfigChange({ action: 'rename', card: 'risks' })).toThrow('action');
    expect(() => parseCardConfigChange(undefined)).toThrow('action');
  });
});
