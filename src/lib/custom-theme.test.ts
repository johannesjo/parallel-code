import { describe, it, expect } from 'vitest';
import {
  parseThemeCss,
  buildCustomThemeCss,
  themeToCss,
  detectThemeTone,
  collectAllowedVars,
  formatVarLines,
  isHexTerminalBackground,
  checkThemeContrast,
} from './custom-theme';

describe('parseThemeCss', () => {
  it('parses a valid CSS theme with header comment', () => {
    const css = `/*
  name: Midnight Plum
  terminalBackground: #1a1a2e
*/

:root {
  --bg: #0f0e17;
  --fg: #fffffe;
}`;
    const result = parseThemeCss(css);
    expect(result.name).toBe('Midnight Plum');
    expect(result.description).toBe('');
    expect(result.terminalBackground).toBe('#1a1a2e');
    expect(result.vars['--bg']).toBe('#0f0e17');
    expect(result.vars['--fg']).toBe('#fffffe');
  });

  it('preserves inline comments and still parses values', () => {
    const css = `/*
  name: Test
  terminalBackground: #000
*/
:root {
  --bg: #0f0e17; /* App background */
  --fg: #fffffe; /* Primary text */
}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#0f0e17');
    expect(result.vars['--fg']).toBe('#fffffe');
  });

  it('throws when header comment is missing', () => {
    expect(() => parseThemeCss(':root { --bg: #000; }')).toThrow('header comment block');
  });

  it('throws when name is missing from header', () => {
    const css = `/* terminalBackground: #000 */\n:root { --bg: #000; }`;
    expect(() => parseThemeCss(css)).toThrow('name');
  });

  it('throws when terminalBackground is missing from header', () => {
    const css = `/* name: My Theme */\n:root { --bg: #000; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('silently ignores unknown CSS variable names', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111;\n  --unknown-key: #fff;\n}`;
    const result = parseThemeCss(css);
    expect('--bg' in result.vars).toBe(true);
    expect('--unknown-key' in result.vars).toBe(false);
  });

  it('handles values without trailing semicolon', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111\n}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#111');
  });

  it('parses gradient values correctly', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%);\n}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe(
      'radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%)',
    );
  });

  it('correctly parses multiple declarations on one line', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root { --bg: #111; --fg: #fff; }`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#111');
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('throws when :root block contains nested rules', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111;\n  @media (x) { --fg: #fff; }\n}`;
    expect(() => parseThemeCss(css)).toThrow('Nested rules');
  });

  it('throws when :root block is missing', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\nbody { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow(':root');
  });

  it('throws when :root block has no recognized CSS variables', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root { --unknown-a: #111; --unknown-b: #fff; }`;
    expect(() => parseThemeCss(css)).toThrow('recognized CSS variables');
  });

  it('throws when terminalBackground is not a valid opaque color', () => {
    const css = `/*\n  name: x\n  terminalBackground: linear-gradient(red, blue)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('throws when terminalBackground has transparency (rgba)', () => {
    const css = `/*\n  name: x\n  terminalBackground: rgba(0,0,0,0.5)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('throws when terminalBackground is rgb() instead of hex', () => {
    const css = `/*\n  name: x\n  terminalBackground: rgb(1,2,3)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('ignores variables in non-root blocks', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\nbody { --bg: #bad; }\n:root { --fg: #fff; }`;
    const result = parseThemeCss(css);
    expect('--bg' in result.vars).toBe(false);
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('treats commented-out :root block as missing', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n/* :root { --bg: #111; } */`;
    expect(() => parseThemeCss(css)).toThrow(':root');
  });
});

describe('themeToCss', () => {
  it('serializes to the expected CSS format', () => {
    const css = themeToCss('My Theme', 'A moody dark theme', '#1a1a2e', {
      '--bg': '#0f0e17',
      '--fg': '#fffffe',
    });
    expect(css).toContain('name: My Theme');
    expect(css).toContain('terminalBackground: #1a1a2e');
    expect(css).toContain('--bg: #0f0e17;');
    expect(css).toContain('--fg: #fffffe;');
    expect(css).toContain('description: A moody dark theme');
    // round-trips
    const parsed = parseThemeCss(css);
    expect(parsed.name).toBe('My Theme');
    expect(parsed.description).toBe('A moody dark theme');
    expect(parsed.terminalBackground).toBe('#1a1a2e');
    expect(parsed.vars['--bg']).toBe('#0f0e17');
  });
});

describe('custom theme helper primitives', () => {
  it('recognizes only opaque 3- or 6-digit hex terminal backgrounds', () => {
    expect(isHexTerminalBackground('#000')).toBe(true);
    expect(isHexTerminalBackground('#1a2B3c')).toBe(true);
    expect(isHexTerminalBackground(' #fff ')).toBe(true);
    expect(isHexTerminalBackground('#abcd')).toBe(false);
    expect(isHexTerminalBackground('rgb(0,0,0)')).toBe(false);
  });

  it('collects recognized string CSS variables and ignores unknown or non-string entries', () => {
    expect(
      collectAllowedVars([
        ['--bg', '#000'],
        ['--unknown', '#fff'],
        ['--fg', 123],
      ]),
    ).toEqual({ '--bg': '#000' });
  });

  it('supports semantic diff and search colors in custom themes', () => {
    expect(
      collectAllowedVars([
        ['--diff-add-bg', 'rgba(47, 209, 152, 0.1)'],
        ['--diff-remove-bg', 'rgba(255, 95, 115, 0.1)'],
        ['--search-match', '#ffd54f'],
        ['--search-match-active', '#ff8a00'],
      ]),
    ).toEqual({
      '--diff-add-bg': 'rgba(47, 209, 152, 0.1)',
      '--diff-remove-bg': 'rgba(255, 95, 115, 0.1)',
      '--search-match': '#ffd54f',
      '--search-match-active': '#ff8a00',
    });
  });

  it('can apply CSS value validation when collecting parser declarations', () => {
    expect(
      collectAllowedVars(
        [
          ['--bg', 'url("https://example.com/bg.png")'],
          ['--fg', '#fff'],
        ],
        { validateValues: true },
      ),
    ).toEqual({ '--fg': '#fff' });
  });

  it('formats variable lines in supported CSS variable order by default', () => {
    expect(formatVarLines({ '--fg': '#fff', '--bg': '#000' })).toBe('  --bg: #000;\n  --fg: #fff;');
  });
});

describe('checkThemeContrast', () => {
  it('warns when subtle text falls below 4.5:1 on elevated backgrounds', () => {
    const warnings = checkThemeContrast({
      '--bg-elevated': '#ffffff',
      '--bg-selected': '#ffffff',
      '--fg': '#000000',
      '--fg-muted': '#555555',
      '--fg-subtle': '#888888',
      '--accent': '#000000',
      '--accent-text': '#ffffff',
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        fgVar: '--fg-subtle',
        bgVar: '--bg-elevated',
        required: 4.5,
      }),
    ]);
  });

  it('checks subtle text on the island background panels use', () => {
    const warnings = checkThemeContrast({
      '--bg-elevated': '#000000',
      '--island-bg': '#555555',
      '--fg-subtle': '#aaaaaa',
    });

    expect(warnings).toEqual([
      expect.objectContaining({ fgVar: '--fg-subtle', bgVar: '--island-bg', required: 4.5 }),
    ]);
  });
});

describe('buildCustomThemeCss', () => {
  it('generates a css rule for data-look=custom:id', () => {
    const css = buildCustomThemeCss({
      id: 'abc',
      name: 'Test',
      description: '',
      terminalBackground: '#111',
      vars: { '--bg': '#0f0e17', '--fg': '#fff' },
    });
    expect(css).toContain("html[data-custom-theme='abc']");
    expect(css).toContain('--bg: #0f0e17');
    expect(css).toContain('--fg: #fff');
  });

  it('returns empty string for theme with no vars', () => {
    const css = buildCustomThemeCss({
      id: 'x',
      name: 'Empty',
      description: '',
      terminalBackground: '#000',
      vars: {},
    });
    expect(css).toBe('');
  });
});

describe('parseThemeCss — value validation', () => {
  const header = `/*\n  name: T\n  terminalBackground: #000\n*/\n`;

  it('strips url() values to prevent resource loads', () => {
    const result = parseThemeCss(
      `${header}:root { --bg: url("https://example.com"); --fg: #fff; }`,
    );
    expect(result.vars['--bg']).toBeUndefined();
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('strips @-containing values to prevent at-rule injection', () => {
    const result = parseThemeCss(`${header}:root { --fg: @import "evil"; --bg: #000; }`);
    expect(result.vars['--fg']).toBeUndefined();
    expect(result.vars['--bg']).toBe('#000');
  });

  it('strips values containing control characters', () => {
    const result = parseThemeCss(`${header}:root { --bg: #000\x01; --fg: #fff; }`);
    expect(result.vars['--bg']).toBeUndefined();
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('accepts --island-radius with valid px values', () => {
    const r = parseThemeCss(`${header}:root { --island-radius: 12px; --fg: #fff; }`);
    expect(r.vars['--island-radius']).toBe('12px');
    const r2 = parseThemeCss(`${header}:root { --island-radius: 0; --fg: #fff; }`);
    expect(r2.vars['--island-radius']).toBe('0');
  });

  it('strips --island-radius with non-px values', () => {
    const r = parseThemeCss(`${header}:root { --island-radius: 50%; --fg: #fff; }`);
    expect(r.vars['--island-radius']).toBeUndefined();
    const r2 = parseThemeCss(`${header}:root { --island-radius: 12em; --fg: #fff; }`);
    expect(r2.vars['--island-radius']).toBeUndefined();
  });

  it('passes valid hex colors through unchanged', () => {
    const result = parseThemeCss(`${header}:root { --bg: #1a1a2e; --accent: #4267ff; }`);
    expect(result.vars['--bg']).toBe('#1a1a2e');
    expect(result.vars['--accent']).toBe('#4267ff');
  });

  it('passes CSS gradients through unchanged', () => {
    const css = `${header}:root { --bg: radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%); --fg: #fff; }`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe(
      'radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%)',
    );
  });
});

describe('detectThemeTone', () => {
  it('returns dark for a dark background', () => {
    expect(detectThemeTone({ '--bg-elevated': '#1a1a2e' })).toBe('dark');
  });

  it('returns light for a light background', () => {
    expect(detectThemeTone({ '--bg-elevated': '#ffffff' })).toBe('light');
  });

  it('prefers --bg-elevated over --bg', () => {
    // --bg-elevated is light, --bg is dark — should pick light
    expect(detectThemeTone({ '--bg-elevated': '#ffffff', '--bg': '#000000' })).toBe('light');
  });

  it('falls back to --bg when --bg-elevated is missing', () => {
    expect(detectThemeTone({ '--bg': '#ffffff' })).toBe('light');
    expect(detectThemeTone({ '--bg': '#111111' })).toBe('dark');
  });

  it('returns dark when both vars are missing', () => {
    expect(detectThemeTone({})).toBe('dark');
  });

  it('returns dark for an unparseable color string', () => {
    expect(detectThemeTone({ '--bg-elevated': 'not-a-color' })).toBe('dark');
  });

  it('returns dark for a gradient in --bg with no --bg-elevated', () => {
    expect(
      detectThemeTone({ '--bg': 'radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%)' }),
    ).toBe('dark');
  });
});
