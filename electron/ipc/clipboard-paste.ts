import { fileURLToPath } from 'url';

/** What a terminal paste should insert; mirrored by `ClipboardPaste` in TerminalView. */
type ClipboardPaste =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

/** The parts of Electron's (async, W3C-style) clipboard this module reads. */
interface PasteClipboardEntry {
  readonly types: string[];
  getType(type: string): Promise<unknown>;
}

interface PasteClipboard {
  read(): Promise<PasteClipboardEntry[]>;
  readText(): Promise<string>;
}

interface ResolvePasteDeps {
  clipboard: PasteClipboard;
  /** Store image bytes as a PNG file and return its path. `mime` is the
   *  clipboard type the bytes came from, so non-PNG images can be converted;
   *  null when they do not decode as an image. */
  saveImage(bytes: Uint8Array, mime: string): Promise<string | null>;
}

/** A platform clipboard format with no standard MIME mapping, as Electron names it. */
export function osClipboardType(format: string): string {
  return `electron application/osclipboard;format="${format}"`;
}

const MAC_FILE_URL = osClipboardType('public.file-url');
const GNOME_COPIED_FILES = osClipboardType('x-special/gnome-copied-files');
// Electron maps this to the OS's own copied-files format: CF_HDROP on
// Windows, NSFilenamesPboardType on macOS, text/uri-list on Linux.
const URI_LIST = 'text/uri-list';

interface BlobLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobLike).text === 'function' &&
    typeof (value as BlobLike).arrayBuffer === 'function'
  );
}

async function readBlob(entries: PasteClipboardEntry[], type: string): Promise<BlobLike | null> {
  const entry = entries.find((e) => e.types.includes(type));
  if (!entry) return null;
  const value = await entry.getType(type);
  return isBlobLike(value) ? value : null;
}

async function readString(entries: PasteClipboardEntry[], type: string): Promise<string | null> {
  const blob = await readBlob(entries, type);
  // Raw OS payloads may carry a C string's terminator.
  return blob ? (await blob.text()).replace(/\0+$/, '') : null;
}

/** First file URL on the clipboard, or null if none.
 *  macOS publishes `public.file-url` (one URL).
 *  Linux file managers vary:
 *    - Files (Nautilus), Nemo, etc. publish `x-special/gnome-copied-files`
 *      as `<verb>\nfile:///path1\nfile:///path2`, where <verb> is `copy`
 *      or `cut`. This is the dominant Linux desktop format and MUST be
 *      checked before `text/uri-list` because some apps publish both
 *      flavours and the GNOME flavour is the authoritative one.
 *    - Falls back to `text/uri-list` (RFC 2483) for KDE, Xfce, and any
 *      cross-desktop publisher; on Windows this is Explorer's file copy. */
async function readFileUrl(entries: PasteClipboardEntry[]): Promise<string | null> {
  const macUrl = (await readString(entries, MAC_FILE_URL))?.trim();
  if (macUrl) return macUrl;

  const gnome = await readString(entries, GNOME_COPIED_FILES);
  if (gnome !== null) {
    // First line is the verb (copy/cut); subsequent lines are file URLs.
    const lines = gnome.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('file://')) return trimmed;
    }
  }

  const list = await readString(entries, URI_LIST);
  if (list !== null) {
    for (const line of list.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('file://')) return trimmed;
    }
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

/** Resolve the most useful representation of the clipboard for pasting into
 *  a terminal. Order of preference:
 *    1. file references (Finder, Nautilus, Explorer copy) → absolute path
 *    2. raster image (screenshot, image-app copy)        → saved PNG path
 *    3. plain text                                       → as-is
 *  Without (1), copying an image file from a file manager gives only the
 *  basename via navigator.clipboard.readText(), which is useless to a CLI
 *  agent that needs a path it can stat. */
export async function resolveClipboardPaste(deps: ResolvePasteDeps): Promise<ClipboardPaste> {
  const entries = await deps.clipboard.read();

  const fileUrl = await readFileUrl(entries);
  if (fileUrl) {
    const filePath = fileUrlToPath(fileUrl);
    if (filePath) return { kind: 'file', path: filePath };
  }

  const types = entries.flatMap((e) => e.types);
  const imageType = types.includes('image/png')
    ? 'image/png'
    : types.find((t) => t.startsWith('image/'));
  if (imageType) {
    const blob = await readBlob(entries, imageType);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const imagePath = bytes.length > 0 ? await deps.saveImage(bytes, imageType) : null;
      if (imagePath) return { kind: 'image', path: imagePath };
    }
  }

  const text = await deps.clipboard.readText();
  if (text) return { kind: 'text', text };
  return { kind: 'empty' };
}
