import { describe, expect, it } from 'vitest';
import { isSupportedAskCodeImagePath } from './ask-code-image.js';

describe('isSupportedAskCodeImagePath', () => {
  it('accepts supported image file extensions case-insensitively', () => {
    expect(isSupportedAskCodeImagePath('/tmp/screenshot.PNG')).toBe(true);
    expect(isSupportedAskCodeImagePath('/tmp/photo.jpeg')).toBe(true);
    expect(isSupportedAskCodeImagePath('/tmp/animation.gif')).toBe(true);
  });

  it('rejects non-image clipboard files', () => {
    expect(isSupportedAskCodeImagePath('/tmp/notes.txt')).toBe(false);
    expect(isSupportedAskCodeImagePath('/tmp/image.svg')).toBe(false);
  });
});
