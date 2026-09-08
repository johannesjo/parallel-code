import { colord, extend } from 'colord';
import a11yPlugin from 'colord/plugins/a11y';

extend([a11yPlugin]);

export const CSS_VARS = [
  '--bg',
  '--bg-elevated',
  '--bg-input',
  '--bg-hover',
  '--bg-selected',
  '--bg-selected-subtle',
  '--border',
  '--border-subtle',
  '--border-focus',
  '--fg',
  '--fg-muted',
  '--fg-subtle',
  '--accent',
  '--accent-hover',
  '--accent-text',
  '--link',
  '--success',
  '--error',
  '--warning',
  '--review',
  '--info',
  '--island-bg',
  '--island-border',
  '--island-radius',
  '--task-container-bg',
  '--task-panel-bg',
  '--diff-add-bg',
  '--diff-remove-bg',
  '--search-match',
  '--search-match-active',
] as const;

export type CssVar = (typeof CSS_VARS)[number];

export interface CustomTheme {
  id: string;
  name: string;
  description: string;
  terminalBackground: string;
  vars: Partial<Record<CssVar, string>>;
}

const CSS_VAR_SET = new Set<string>(CSS_VARS);

// Rejects CSS values that could trigger resource loads, inject at-rules, or
// smuggle control characters. Legitimate values (hex, gradients, px) all pass.
// eslint-disable-next-line no-control-regex
const DANGEROUS_CSS_RE = /url\s*\(|image-set\s*\(|@|[\x00-\x1f]/i;

function isAllowedCssValue(varName: string, value: string): boolean {
  if (DANGEROUS_CSS_RE.test(value)) return false;
  if (varName === '--island-radius') return /^\d+px$|^0$/.test(value);
  return true;
}

export function isHexTerminalBackground(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

export function collectAllowedVars(
  entries: Iterable<[string, unknown]>,
  options?: { validateValues?: boolean },
): Partial<Record<CssVar, string>> {
  const vars: Partial<Record<CssVar, string>> = {};
  for (const [key, value] of entries) {
    if (!CSS_VAR_SET.has(key) || typeof value !== 'string') continue;
    if (options?.validateValues && !isAllowedCssValue(key, value)) continue;
    vars[key as CssVar] = value;
  }
  return vars;
}

export function formatVarLines(
  vars: Partial<Record<CssVar, string>>,
  options?: { ordered?: boolean },
): string {
  const entries =
    options?.ordered === false
      ? Object.entries(vars)
      : CSS_VARS.filter((v) => v in vars).map((v) => [v, vars[v]] as const);
  return entries.map(([k, v]) => `  ${k}: ${v};`).join('\n');
}

const CSS_VAR_DESCRIPTIONS: Record<CssVar, string> = {
  '--bg':
    'App-wide page background. Can be a hex color or CSS gradient (e.g. radial-gradient(130% 120% at 18% 0%, #202044 0%, #171c30 58%, #12151f 100%))',
  '--bg-elevated': 'Raised surfaces: panels, dropdowns, tooltips',
  '--bg-input': 'Input fields and code editor backgrounds',
  '--bg-hover': 'Hover state background for buttons and list items',
  '--bg-selected': 'Selected item background (active task, highlighted row)',
  '--bg-selected-subtle':
    'Subtle selected state — same hue as --bg-selected with ~25% alpha (e.g. #2d2b5840)',
  '--border': 'Primary border for panels and inputs',
  '--border-subtle': 'Softer secondary borders',
  '--border-focus': 'Focus ring color when a field is focused (usually matches accent)',
  '--fg': 'Primary text color — must be readable on --bg-elevated',
  '--fg-muted': 'Secondary text, less important labels',
  '--fg-subtle': 'Tertiary text, placeholders, disabled states',
  '--accent': 'Primary interactive color — buttons, checkboxes, active indicators',
  '--accent-hover': 'Lighter/brighter version of accent for hover states',
  '--accent-text': 'Text color ON accent-colored backgrounds (usually white or near-black)',
  '--link': 'Hyperlink color (often a lighter, more saturated accent)',
  '--success': 'Success states, positive indicators (usually green-ish)',
  '--error': 'Error states, destructive actions (usually red-ish)',
  '--warning': 'Warning states, caution indicators (usually amber/orange)',
  '--review': 'Tasks awaiting review — a hue distinct from accent, success and warning',
  '--info': 'Neutral informational states (investigation steps, sub-task chips)',
  '--island-bg':
    'Background of task column "islands" — typically 1-2 shades darker than bg-elevated',
  '--island-border': 'Border around task column islands',
  '--island-radius': 'Corner radius for islands (e.g. 12px, 8px, or 0px for sharp)',
  '--task-container-bg': 'Background of the task list container within an island',
  '--task-panel-bg':
    'Content panel backgrounds inside tasks (conceptually matches terminalBackground)',
  '--diff-add-bg': 'Background tint for added diff lines',
  '--diff-remove-bg': 'Background tint for removed diff lines',
  '--search-match': 'Background color for search matches',
  '--search-match-active': 'Background color for the active search match',
};

export function validateCustomTheme(input: unknown): Omit<CustomTheme, 'id'> {
  if (!input || typeof input !== 'object') throw new Error('Theme must be an object');
  const obj = input as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || !obj['name'].trim())
    throw new Error('"name" must be a non-empty string');

  if (typeof obj['terminalBackground'] !== 'string' || !obj['terminalBackground'].trim())
    throw new Error('"terminalBackground" must be a hex color string (e.g. "#1a1a2e")');

  if (!obj['vars'] || typeof obj['vars'] !== 'object' || Array.isArray(obj['vars']))
    throw new Error('"vars" must be a mapping of CSS variable names to values');

  const rawVars = obj['vars'] as Record<string, unknown>;
  const vars = collectAllowedVars(Object.entries(rawVars));

  if (Object.keys(vars).length === 0)
    throw new Error('"vars" must contain at least one recognized CSS variable');

  const terminalBackground = (obj['terminalBackground'] as string).trim();
  if (!isHexTerminalBackground(terminalBackground))
    throw new Error('"terminalBackground" must be a 3- or 6-digit hex color (e.g. #1a1a2e)');

  const description = typeof obj['description'] === 'string' ? obj['description'].trim() : '';
  return { name: obj['name'].trim(), description, terminalBackground, vars };
}

/**
 * Parse a CSS theme string in the header-comment format and validate it.
 *
 * Expected format:
 *   /*
 *    *  name: My Theme
 *    *  terminalBackground: #1a1a2e
 *    *\/
 *
 *   :root {
 *     --bg: #0f0e17;  /* App background *\/
 *     --fg: #fffffe;
 *   }
 */
export function parseThemeCss(cssString: string): Omit<CustomTheme, 'id'> {
  // Extract the first /* ... */ comment block for metadata
  const commentMatch = cssString.match(/\/\*([\s\S]*?)\*\//);
  if (!commentMatch) {
    throw new Error(
      'Missing header comment block. The CSS must start with a /* ... */ comment containing name: and terminalBackground:',
    );
  }

  const commentBody = commentMatch[1];

  const nameMatch = commentBody.match(/^\s*name\s*:\s*(.+)$/m);
  if (!nameMatch || !nameMatch[1].trim()) {
    throw new Error('Missing "name:" in header comment (e.g.  name: My Theme)');
  }
  const name = nameMatch[1].trim();

  const termBgMatch = commentBody.match(/^\s*terminalBackground\s*:\s*(.+)$/m);
  if (!termBgMatch || !termBgMatch[1].trim()) {
    throw new Error(
      'Missing "terminalBackground:" in header comment (e.g.  terminalBackground: #1a1a2e)',
    );
  }
  const terminalBackground = termBgMatch[1].trim();

  const descMatch = commentBody.match(/^\s*description\s*:\s*(.+)$/m);
  const description = descMatch ? descMatch[1].trim() : '';

  // Strip block comments from the body before scanning so that commented-out
  // :root blocks are not mistakenly treated as real overrides.
  const strippedCss = cssString.replace(/\/\*[\s\S]*?\*\//g, '');

  if (!/:root\s*\{/.test(strippedCss)) {
    throw new Error(
      'Missing :root {} block. The CSS must include a :root { } rule with variable overrides.',
    );
  }

  // Extract CSS variable declarations from :root {} blocks only.
  // Use brace-counting rather than [^}]* so CSS values containing } (e.g. url("...}"))
  // don't silently truncate the block.
  const vars: Partial<Record<CssVar, string>> = {};
  const declRe = /(--[\w-]+)\s*:\s*([^;]+)/g;
  const rootStartRe = /:root\s*\{/g;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = rootStartRe.exec(strippedCss)) !== null) {
    const openBrace = startMatch.index + startMatch[0].length - 1;
    let depth = 1;
    let i = openBrace + 1;
    while (i < strippedCss.length && depth > 0) {
      if (strippedCss[i] === '{') depth++;
      else if (strippedCss[i] === '}') depth--;
      i++;
    }
    const blockContent = strippedCss.slice(openBrace + 1, i - 1);
    if (blockContent.includes('{')) {
      throw new Error(
        'Nested rules inside :root {} are not supported. Move all variable declarations to a flat :root { } block.',
      );
    }
    declRe.lastIndex = 0;
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRe.exec(blockContent)) !== null) {
      const key = declMatch[1];
      const value = declMatch[2].trim();
      Object.assign(vars, collectAllowedVars([[key, value]], { validateValues: true }));
    }
    // Advance rootStartRe past the block we just processed
    rootStartRe.lastIndex = i;
  }

  if (Object.keys(vars).length === 0) {
    throw new Error(
      'No recognized CSS variables found in :root {}. Add at least one variable from the supported list (e.g. --bg, --fg).',
    );
  }

  if (!isHexTerminalBackground(terminalBackground)) {
    throw new Error(
      '"terminalBackground" must be a 3- or 6-digit hex color (e.g. #1a1a2e) — rgb(), hsl(), and gradients are not allowed',
    );
  }

  return { name, description, terminalBackground, vars };
}

/** Returns 'light' or 'dark' based on the luminance of the theme's background. */
export function detectThemeTone(vars: Partial<Record<CssVar, string>>): 'light' | 'dark' {
  // --bg-elevated is always a solid color (no gradients), making it reliable for luminance
  const bg = vars['--bg-elevated'] ?? vars['--bg'];
  if (!bg) return 'dark';
  try {
    return colord(bg).luminance() > 0.5 ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Serializes theme data to the CSS format the dialog accepts. */
export function themeToCss(
  name: string,
  description: string,
  terminalBackground: string,
  vars: Partial<Record<CssVar, string>>,
): string {
  const varLines = formatVarLines(vars);
  const descLine = description ? `\n  description: ${description}` : '';
  return `/*\n  name: ${name}${descLine}\n  terminalBackground: ${terminalBackground}\n*/\n\n:root {\n${varLines}\n}\n`;
}

export function buildCustomThemeCss(theme: CustomTheme): string {
  const entries = Object.entries(theme.vars);
  if (entries.length === 0) return '';
  const body = formatVarLines(theme.vars, { ordered: false });
  return `html[data-custom-theme='${theme.id}'] {\n${body}\n}`;
}

export interface ContrastWarning {
  fgVar: CssVar;
  bgVar: CssVar;
  fg: string;
  bg: string;
  ratio: number;
  required: number;
}

/** Pairs to check: [fgVar, bgVar, minimumRatio] */
const CONTRAST_PAIRS: [CssVar, CssVar, number][] = [
  ['--fg', '--bg-elevated', 4.5],
  ['--fg-muted', '--bg-elevated', 3.0],
  ['--fg-subtle', '--bg-elevated', 3.0],
  ['--fg', '--bg-selected', 4.5],
  ['--accent-text', '--accent', 4.5],
];

/** Alpha-blend a color over an opaque background, returning the composited hex. */
function blendOver(color: string, backdrop: string): string {
  const c = colord(color).toRgb();
  const b = colord(backdrop).toRgb();
  const a = c.a ?? 1;
  return colord({
    r: Math.round(c.r * a + b.r * (1 - a)),
    g: Math.round(c.g * a + b.g * (1 - a)),
    b: Math.round(c.b * a + b.b * (1 - a)),
  }).toHex();
}

export function checkThemeContrast(vars: Partial<Record<CssVar, string>>): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  const bgElevated = vars['--bg-elevated'];

  for (const [fgVar, bgVar, required] of CONTRAST_PAIRS) {
    const fg = vars[fgVar];
    const bg = vars[bgVar];
    if (!fg || !bg) continue;
    try {
      // If the bg has alpha, composite it over --bg-elevated before checking.
      // Without blending, rgba(x,y,z,0.2) would be compared against white,
      // producing false positives for intentionally translucent selected states.
      const resolvedBg = bgElevated && colord(bg).alpha() < 1 ? blendOver(bg, bgElevated) : bg;

      const ratio = colord(fg).contrast(colord(resolvedBg));
      if (isFinite(ratio) && ratio < required) {
        warnings.push({ fgVar, bgVar, fg, bg, ratio: Math.round(ratio * 100) / 100, required });
      }
    } catch {
      // unparseable color value — skip
    }
  }
  return warnings;
}

const RULES = `RULES:
- All --bg-* and --fg-* values must be hex colors (no gradients)
- --bg may be a CSS gradient if the aesthetic calls for it
- --bg-selected-subtle should be the same hue as --bg-selected with ~25% opacity appended (e.g. #2d2b5840)
- --island-radius should be 12px, 8px, or 0px
- Ensure sufficient contrast: --fg on --bg-elevated should meet WCAG AA (4.5:1 ratio)
- terminalBackground must be an opaque hex value`;

export function generateThemePrompt(existingCss?: string): string {
  const preamble = `You are a UI theme designer for Parallel Code, a dark-mode terminal multiplexer and AI coding assistant.`;

  if (existingCss) {
    return `${preamble}

I have an existing theme I'd like to modify. Ask me what I'd like to change, then output the complete updated CSS (keep inline comments where helpful).

CURRENT THEME:
\`\`\`css
${existingCss.trim()}
\`\`\`

VARIABLES AND THEIR ROLES:
${CSS_VARS.map((v) => `/* ${v}: ${CSS_VAR_DESCRIPTIONS[v]} */`).join('\n')}

/* terminalBackground: Opaque hex color for the terminal emulator (hex only, no gradients) */

${RULES}
`;
  }

  const varList = CSS_VARS.map((v) => `  ${v}: ; /* ${CSS_VAR_DESCRIPTIONS[v]} */`).join('\n');

  return `${preamble}

Help me create a custom color theme by asking about my aesthetic preferences, then filling in the CSS template.

VARIABLES AND THEIR ROLES:
${CSS_VARS.map((v) => `/* ${v}: ${CSS_VAR_DESCRIPTIONS[v]} */`).join('\n')}

/* terminalBackground: Opaque hex color for the terminal emulator (hex only, no gradients — should match --task-panel-bg conceptually) */

Please:
1. Ask me about my aesthetic preferences (mood, accent color, reference themes I like, light vs dark)
2. Generate a complete theme in this exact CSS format when ready (keep the comments — they help the user understand each value):

/*
  name: My Theme Name
  description: One-line description of the theme's mood or style
  terminalBackground: #hex
*/

:root {
${varList}
}

${RULES}
`;
}
