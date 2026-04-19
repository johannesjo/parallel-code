import type { Highlighter, BundledLanguage, BundledTheme, SpecialLanguage } from 'shiki';

const THEME: BundledTheme = 'github-dark';

/** Map file extensions to Shiki language identifiers. */
const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  rs: 'rust',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'dockerfile',
  lua: 'lua',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
};

/** Basenames that map to a language regardless of extension. */
const BASENAME_TO_LANG: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

/** Deduplicated set of languages to pre-load. */
const PRELOAD_LANGS: BundledLanguage[] = [
  ...new Set([...Object.values(EXT_TO_LANG), ...Object.values(BASENAME_TO_LANG)]),
];

let highlighterPromise: Promise<Highlighter> | undefined;

/** Lazy singleton — creates the highlighter on first call. */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((m) =>
      m.createHighlighter({
        themes: [THEME],
        langs: PRELOAD_LANGS,
      }),
    );
  }
  return highlighterPromise;
}

/**
 * Detect a Shiki language identifier from a file path.
 * Checks special basenames first, then file extension. Falls back to 'plaintext'.
 */
export function detectLang(filePath: string): string {
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  const match = BASENAME_TO_LANG[basename];
  if (match) return match;

  const ext = basename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Highlight `code` with Shiki and return one HTML string per line.
 * Each token is wrapped in `<span style="color:…">…</span>`.
 * Falls back to 'plaintext' when the requested language is not loaded.
 */
export async function highlightLines(code: string, lang: string): Promise<string[]> {
  const hl = await getHighlighter();

  // Fall back to plaintext if the language isn't loaded
  const loadedLangs = hl.getLoadedLanguages() as string[];
  const effectiveLang: BundledLanguage | SpecialLanguage =
    loadedLangs.includes(lang) || lang === 'plaintext' ? (lang as BundledLanguage) : 'plaintext';

  const { tokens } = hl.codeToTokens(code, {
    lang: effectiveLang,
    theme: THEME,
  });

  return tokens.map((line) =>
    line
      .map((token) => {
        const escaped = escapeHtml(token.content);
        if (token.color) {
          return `<span style="color:${token.color}">${escaped}</span>`;
        }
        return escaped;
      })
      .join(''),
  );
}
