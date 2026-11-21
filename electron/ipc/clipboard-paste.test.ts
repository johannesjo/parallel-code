import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { osClipboardType, resolveClipboardPaste } from './clipboard-paste.js';

type Payload = string | Uint8Array<ArrayBuffer>;

/** An absolute path on this platform (with a drive letter on Windows, where a
 *  file URL without one does not convert), and its file URL. */
function file(posixPath: string): { path: string; url: string } {
  const absolute = path.resolve(posixPath);
  return { path: absolute, url: pathToFileURL(absolute).href };
}

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
    const picked = file('/Users/me/a b.png');
    expect(picked.url).toContain('a%20b.png');
    const { result } = resolve({
      [osClipboardType('public.file-url')]: `${picked.url}\0`,
      'text/uri-list': file('/other').url,
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: picked.path });
  });

  it('prefers the GNOME copied-files list over text/uri-list', async () => {
    const one = file('/home/me/one.txt');
    const { result } = resolve({
      [osClipboardType('x-special/gnome-copied-files')]: `copy\n${one.url}`,
      'text/uri-list': file('/home/me/two.txt').url,
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: one.path });
  });

  it('reads the first file of a CRLF text/uri-list, skipping comments', async () => {
    const one = file('/home/me/one.txt');
    const two = file('/home/me/two.txt');
    const { result } = resolve({
      'text/uri-list': `# from KDE\r\n${one.url}\r\n${two.url}`,
    });
    await expect(result).resolves.toEqual({ kind: 'file', path: one.path });
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
