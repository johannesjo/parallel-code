import { describe, expect, it, vi } from 'vitest';
import { osClipboardType, resolveClipboardPaste } from './clipboard-paste.js';

type Payload = string | Uint8Array<ArrayBuffer>;

/** One clipboard entry exposing each payload under its type, the way
 *  Electron's `clipboard.read()` reports a single OS clipboard. */
function fakeClipboard(payloads: Record<string, Payload>, text = '') {
  const entry = {
    types: Object.keys(payloads),
    getType: (type: string) => {
      const payload = payloads[type];
      if (payload === undefined) return Promise.reject(new Error(`no ${type}`));
      return Promise.resolve(new Blob([payload]));
    },
  };
  return { read: () => Promise.resolve([entry]), readText: () => Promise.resolve(text) };
}

function resolve(payloads: Record<string, Payload>, text = '') {
  const saveImage = vi.fn((_bytes: Uint8Array, _mime: string) =>
    Promise.resolve<string | null>('/tmp/clip.png'),
  );
  return {
    saveImage,
    result: resolveClipboardPaste({ clipboard: fakeClipboard(payloads, text), saveImage }),
  };
}

describe('resolveClipboardPaste', () => {
  it('uses the macOS file URL first', async () => {
    const { result } = resolve({
      [osClipboardType('public.file-url')]: 'file:///Users/me/a%20b.png\0',
      'text/uri-list': 'file:///other',
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: '/Users/me/a b.png' });
  });

  it('prefers the GNOME copied-files list over text/uri-list', async () => {
    const { result } = resolve({
      [osClipboardType('x-special/gnome-copied-files')]: 'copy\nfile:///home/me/one.txt',
      'text/uri-list': 'file:///home/me/two.txt',
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: '/home/me/one.txt' });
  });

  it('reads the first file of a CRLF text/uri-list, skipping comments', async () => {
    const { result } = resolve({
      'text/uri-list': '# from KDE\r\nfile:///home/me/one.txt\r\nfile:///home/me/two.txt',
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: '/home/me/one.txt' });
  });

  it('saves a PNG image and returns its path', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { result, saveImage } = resolve({ 'image/jpeg': new Uint8Array([1]), 'image/png': png });
    await expect(result).resolves.toEqual({ kind: 'image', path: '/tmp/clip.png' });
    expect(saveImage).toHaveBeenCalledWith(png, 'image/png');
  });

  it('hands other image types over for conversion', async () => {
    const { result, saveImage } = resolve({ 'image/jpeg': new Uint8Array([1, 2]) });
    await expect(result).resolves.toEqual({ kind: 'image', path: '/tmp/clip.png' });
    expect(saveImage).toHaveBeenCalledWith(new Uint8Array([1, 2]), 'image/jpeg');
  });

  it('falls back to text when an image does not decode', async () => {
    const saveImage = vi.fn(() => Promise.resolve(null));
    const clipboard = fakeClipboard({ 'image/bmp': new Uint8Array([1]) }, 'hello');
    await expect(resolveClipboardPaste({ clipboard, saveImage })).resolves.toEqual({
      kind: 'text',
      text: 'hello',
    });
  });

  it('returns plain text, or empty when there is nothing', async () => {
    await expect(resolve({ 'text/plain': 'hi' }, 'hi').result).resolves.toEqual({
      kind: 'text',
      text: 'hi',
    });
    await expect(resolve({}).result).resolves.toEqual({ kind: 'empty' });
  });
});
