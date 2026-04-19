import { IPC } from '../../electron/ipc/channels';

/** Well-known monospace fonts used as fallback when system font enumeration is unavailable. */
export const TERMINAL_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Ubuntu Mono',
  'Inconsolata',
  'Hack',
  'Menlo',
  'Consolas',
] as const;

export const DEFAULT_TERMINAL_FONT: string = 'JetBrains Mono';

/** Fonts that ship with programming ligatures (disabled in terminal via CSS). */
export const LIGATURE_FONTS: ReadonlySet<string> = new Set([
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
]);

export function getTerminalFontFamily(font: string): string {
  return `'${font.replace(/'/g, "\\'")}', monospace`;
}

/** Fonts loaded via Google Fonts — always available regardless of local install. */
const WEB_FONTS: ReadonlySet<string> = new Set(['JetBrains Mono']);

/**
 * Returns monospace fonts available on this system.
 * Uses IPC to query the main process (fc-list), falling back to canvas-based
 * detection of the hardcoded TERMINAL_FONTS list.
 */
let systemFontsPromise: Promise<string[]> | null = null;
let systemFontsResult: string[] | null = null;

export function getAvailableTerminalFonts(): string[] {
  // Return cached result synchronously if available
  if (systemFontsResult) return systemFontsResult;
  // Return fallback (web fonts only) while async fetch is in progress
  return [...WEB_FONTS];
}

export async function fetchAvailableTerminalFonts(): Promise<string[]> {
  if (systemFontsResult) return systemFontsResult;
  if (!systemFontsPromise) {
    systemFontsPromise = loadSystemFonts();
  }
  return systemFontsPromise;
}

async function loadSystemFonts(): Promise<string[]> {
  try {
    const systemFonts = (await window.electron.ipcRenderer.invoke(IPC.GetSystemFonts)) as string[];
    if (systemFonts.length === 0) {
      // fc-list unavailable or returned nothing — use canvas fallback
      systemFontsResult = detectFontsViaCanvas();
    } else {
      // Merge web fonts (always available) with system fonts, deduplicated
      const all = new Set<string>([...WEB_FONTS, ...systemFonts]);
      systemFontsResult = [...all].sort((a, b) => a.localeCompare(b));
    }
  } catch {
    // IPC failed — fall back to canvas-based detection of hardcoded list
    systemFontsResult = detectFontsViaCanvas();
  }
  return systemFontsResult;
}

/** Canvas-based detection of the hardcoded TERMINAL_FONTS list (fallback). */
function detectFontsViaCanvas(): string[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return [...TERMINAL_FONTS];

  const testString = 'mmmmmmmmmmlli';
  const fontSize = '72px';
  const fallbacks = ['serif', 'sans-serif'] as const;

  const baseWidths = fallbacks.map((fb) => {
    ctx.font = `${fontSize} ${fb}`;
    return ctx.measureText(testString).width;
  });

  return TERMINAL_FONTS.filter((font) => {
    if (WEB_FONTS.has(font)) return true;
    return fallbacks.some((fb, i) => {
      ctx.font = `${fontSize} '${font}', ${fb}`;
      return ctx.measureText(testString).width !== baseWidths[i];
    });
  });
}
