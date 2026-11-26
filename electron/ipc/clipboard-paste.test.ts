import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, readText, createFromBuffer } = vi.hoisted(() => ({
  read: vi.fn(),
  readText: vi.fn(),
  createFromBuffer: vi.fn(),
}));
vi.mock('electron', () => ({ clipboard: { read, readText }, nativeImage: { createFromBuffer } }));

import { resolveClipboardPaste } from './clipboard-paste.js';

const GNOME = 'electron application/osclipboard;format="x-special/gnome-copied-files"';

/** One clipboard entry carrying the given MIME type → payload pairs. */
function item(data: Record<string, BlobPart>) {
  return {
    types: Object.keys(data),
    getType: async (type: string) => new Blob([data[type]]),
  };
}

describe('resolveClipboardPaste', () => {
  let writeFile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    read.mockReset().mockResolvedValue([]);
    readText.mockReset().mockResolvedValue('');
    createFromBuffer.mockReset();
    writeFile = vi.spyOn(fs.promises, 'writeFile').mockReset().mockResolvedValue(undefined);
  });

  it('prefers the GNOME copied-files payload over text/uri-list', async () => {
    read.mockResolvedValue([
      item({
        [GNOME]: 'copy\nfile:///home/u/a.png\nfile:///home/u/b.png',
        'text/uri-list': 'file:///home/u/other.png',
      }),
    ]);
    expect(await resolveClipboardPaste()).toEqual({ kind: 'file', path: '/home/u/a.png' });
  });

  it('reads the first file from a CRLF uri-list, skipping comments', async () => {
    read.mockResolvedValue([item({ 'text/uri-list': '# copied\r\nfile:///tmp/x%20y.txt\r\n' })]);
    expect(await resolveClipboardPaste()).toEqual({ kind: 'file', path: '/tmp/x y.txt' });
  });

  it('saves a clipboard image as PNG and returns its path', async () => {
    const png = Buffer.from('png-bytes');
    createFromBuffer.mockReturnValue({ isEmpty: () => false, toPNG: () => png });
    read.mockResolvedValue([item({ 'image/jpeg': new Uint8Array([1, 2]) })]);

    const result = await resolveClipboardPaste();

    expect(result).toEqual({
      kind: 'image',
      path: expect.stringMatching(/parallel-code-clipboard\.png$/),
    });
    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from([1, 2]));
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/parallel-code-clipboard\.png$/),
      png,
    );
  });

  it('returns text when there is no file and the image is undecodable', async () => {
    createFromBuffer.mockReturnValue({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) });
    read.mockResolvedValue([item({ 'text/uri-list': 'https://example.com', 'image/png': 'x' })]);
    readText.mockResolvedValue('hello');
    expect(await resolveClipboardPaste()).toEqual({ kind: 'text', text: 'hello' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('skips a format that fails to read and falls back to text', async () => {
    read.mockResolvedValue([
      {
        types: [GNOME],
        getType: async () => {
          throw new Error('format vanished');
        },
      },
    ]);
    readText.mockResolvedValue('still pastes');
    expect(await resolveClipboardPaste()).toEqual({ kind: 'text', text: 'still pastes' });
  });

  it('prefers a PNG payload over JPEG', async () => {
    createFromBuffer.mockReturnValue({ isEmpty: () => false, toPNG: () => Buffer.from('out') });
    read.mockResolvedValue([item({ 'image/jpeg': 'jpeg' }), item({ 'image/png': 'png' })]);
    await resolveClipboardPaste();
    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('reports an empty clipboard', async () => {
    expect(await resolveClipboardPaste()).toEqual({ kind: 'empty' });
  });
});
