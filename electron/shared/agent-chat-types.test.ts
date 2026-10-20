import { describe, expect, it } from 'vitest';
import { restoreChatSessions, validateChatImages } from './agent-chat-types.js';

describe('chat input validation', () => {
  it('rejects malformed or oversized images before they reach a provider', () => {
    const image = { name: 'screen.png', mediaType: 'image/png', data: 'aGVsbG8=' };
    expect(validateChatImages([image])).toEqual([image]);
    expect(() => validateChatImages([{ ...image, mediaType: 'image/svg+xml' }])).toThrow();
    expect(() =>
      validateChatImages([{ ...image, data: 'https://example.com/image.png' }]),
    ).toThrow();
    expect(() => validateChatImages(Array(5).fill(image))).toThrow();
    expect(() =>
      validateChatImages([{ ...image, data: 'a'.repeat(8 * 1024 * 1024 + 4) }]),
    ).toThrow();
  });
  it('restores only valid session index entries', () => {
    const session = { threadId: 'one', provider: 'claude', title: 'First chat', updatedAt: 1 };
    expect(
      restoreChatSessions([
        null,
        session,
        { ...session, provider: 'unknown' },
        { ...session, updatedAt: NaN },
      ]),
    ).toEqual([session]);
  });
});
