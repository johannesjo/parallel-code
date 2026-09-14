import { describe, expect, it } from 'vitest';
import { isSupportedAskCodeImageExtension } from './ask-code-image.js';

describe('isSupportedAskCodeImageExtension', () => {
  it('accepts supported image file extensions case-insensitively', () => {
    expect(isSupportedAskCodeImageExtension('/tmp/screenshot.PNG')).toBe(true);
    expect(isSupportedAskCodeImageExtension('/tmp/photo.jpeg')).toBe(true);
    expect(isSupportedAskCodeImageExtension('/tmp/animation.gif')).toBe(true);
  });

  it('rejects non-image clipboard files', () => {
    expect(isSupportedAskCodeImageExtension('/tmp/notes.txt')).toBe(false);
    expect(isSupportedAskCodeImageExtension('/tmp/image.svg')).toBe(false);
  });
});
