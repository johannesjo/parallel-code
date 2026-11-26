import { clipboard, nativeImage, type ClipboardItem } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { errMessage, warn as logWarn } from '../log.js';

export type ClipboardPaste =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

const clipboardImagePath = path.join(os.tmpdir(), 'parallel-code-clipboard.png');

/** Clipboard types that can carry copied files, most authoritative first.
 *  - Files (Nautilus), Nemo, etc. publish `x-special/gnome-copied-files`
 *    as `<verb>\nfile:///path1\nfile:///path2`, where <verb> is `copy`
 *    or `cut`. This is the dominant Linux desktop format and MUST be
 *    checked before `text/uri-list` because some apps publish both
 *    flavours and the GNOME flavour is the authoritative one. Electron
 *    exposes formats without a standard MIME mapping as raw `osclipboard`.
 *  - `text/uri-list` is Electron's mapping of the OS "copied files" format
 *    (macOS `public.file-url`, Windows CF_HDROP, KDE, Xfce and any RFC 2483
 *    publisher). */
const FILE_URL_TYPES = [
  'electron application/osclipboard;format="x-special/gnome-copied-files"',
  'text/uri-list',
];

/** Payload of `type`, or null when absent or unreadable. A format can vanish
 *  between read() and getType(), so one bad entry must not lose the whole paste. */
async function readType(items: ClipboardItem[], type: string): Promise<Blob | null> {
  const item = items.find((i) => i.types.includes(type));
  if (!item) return null;
  try {
    const data = await item.getType(type);
    // Duck-typed: Electron's Blob need not share the global Blob's constructor.
    return 'arrayBuffer' in data ? data : null;
  } catch (err) {
    logWarn('clipboard', 'could not read clipboard format', { type, err: errMessage(err) });
    return null;
  }
}

/** First file URL on the clipboard, or null if none. Every supported payload is
 *  line-based; the GNOME verb line and uri-list `#` comments never start with
 *  `file://`, so taking the first such line handles all of them. */
async function readClipboardFileUrl(items: ClipboardItem[]): Promise<string | null> {
  for (const type of FILE_URL_TYPES) {
    const blob = await readType(items, type);
    if (!blob) continue;
    const url = (await blob.text())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('file://'));
    if (url) return url;
  }
  return null;
}

/** Convert a file:// URL to an absolute path, returning '' on failure. */
function fileUrlToPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return '';
  }
}

/** Clipboard image as PNG bytes (preferring a PNG payload), or null if none. */
async function readClipboardPng(items: ClipboardItem[]): Promise<Buffer | null> {
  const types = items.flatMap((i) => i.types);
  const type = types.includes('image/png')
    ? 'image/png'
    : types.find((t) => t.startsWith('image/'));
  if (!type) return null;
  const blob = await readType(items, type);
  if (!blob) return null;
  // Re-encode through nativeImage so JPEG or other image payloads still land as PNG.
  const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
  return img.isEmpty() ? null : img.toPNG();
}

/** Resolve the most useful representation of the current clipboard contents
 *  for pasting into a terminal. Order of preference:
 *    1. file references (Finder copy, Nautilus copy, etc.) → absolute path
 *    2. raster image (screenshot, image-app copy)         → PNG saved to tmp, its path
 *    3. plain text                                        → returned as-is
 *
 *  Without (1), copying an image file from Finder gives only the basename via
 *  navigator.clipboard.readText(), which is useless to a CLI agent that needs a
 *  path it can stat. */
export async function resolveClipboardPaste(): Promise<ClipboardPaste> {
  const items = await clipboard.read();
  const fileUrl = await readClipboardFileUrl(items);
  if (fileUrl) {
    const filePath = fileUrlToPath(fileUrl);
    if (filePath) return { kind: 'file', path: filePath };
  }
  const png = await readClipboardPng(items);
  if (png) {
    await fs.promises.writeFile(clipboardImagePath, png);
    return { kind: 'image', path: clipboardImagePath };
  }
  const text = await clipboard.readText();
  return text ? { kind: 'text', text } : { kind: 'empty' };
}
