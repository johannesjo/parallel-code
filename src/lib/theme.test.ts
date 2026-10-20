import { afterEach, describe, expect, it, vi } from 'vitest';
import { colord } from 'colord';
import { getTerminalSearchDecorations, getTerminalTheme, theme } from './theme';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme tokens', () => {
  it('exposes semantic diff and search colors', () => {
    expect(theme).toMatchObject({
      diffAddBg: 'var(--diff-add-bg)',
      diffRemoveBg: 'var(--diff-remove-bg)',
      searchMatch: 'var(--search-match)',
      searchMatchActive: 'var(--search-match-active)',
    });
  });
});

describe('getTerminalTheme', () => {
  it('derives a built-in terminal background from the preset task panel token', () => {
    const root = { dataset: { look: 'classic', customTheme: 'custom-id' } };
    vi.stubGlobal('document', {
      documentElement: root,
      getElementById: () => null,
    });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--task-panel-bg' && root.dataset.look === 'islands-light' ? '#fefefe' : '',
    }));

    expect(getTerminalTheme('islands-light').background).toBe('#fefefe');
    expect(root.dataset).toEqual({ look: 'classic', customTheme: 'custom-id' });
  });

  it('gives light presets the light ANSI palette and Obsidian its own', () => {
    vi.stubGlobal('document', { documentElement: { dataset: {} }, getElementById: () => null });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));

    expect(getTerminalTheme('obsidian-light')).toMatchObject({ foreground: '#1f2329' });
    expect(getTerminalTheme('obsidian')).toMatchObject({ foreground: '#e4e4e4' });
    // Other dark presets keep xterm's default palette.
    expect(getTerminalTheme('classic')).not.toHaveProperty('foreground');
  });

  it('keeps Noir terminal text readable on its workspace surface', () => {
    const root = { dataset: { look: 'noir' } };
    vi.stubGlobal('document', { documentElement: root, getElementById: () => null });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => (name === '--task-panel-bg' ? '#15151b' : ''),
    }));

    const noir = getTerminalTheme('noir');
    expect(noir).toMatchObject({ background: '#15151b', cursor: '#b7a5f5' });
    if (!('brightBlack' in noir)) throw new Error('Noir terminal palette is missing');
    // `black` is omitted: TUIs use it as a fill, not as text on the background.
    const textColors = [
      'foreground',
      'cursor',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const;
    for (const name of textColors) {
      const contrast =
        (colord(noir[name]).luminance() + 0.05) / (colord(noir.background).luminance() + 0.05);
      expect(contrast, name).toBeGreaterThanOrEqual(4.5);
    }
    // Magenta output must not be mistaken for the lilac focus accent.
    expect(colord(noir.magenta).hue() - colord(noir.cursor).hue()).toBeGreaterThan(40);
  });

  it('uses the Islands Dark ANSI palette on its CSS-derived background only', () => {
    const root = { dataset: { look: 'classic' } };
    vi.stubGlobal('document', { documentElement: root, getElementById: () => null });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--task-panel-bg' && root.dataset.look === 'islands-dark' ? '#181a1d' : '',
    }));

    const islands = getTerminalTheme('islands-dark');
    expect(islands).toMatchObject({
      background: '#181a1d',
      foreground: '#bcbec4',
      cursor: '#6d9df8',
      cursorAccent: '#181a1d',
      red: '#f75464',
      green: '#6aab73',
      yellow: '#e8a33e',
      blue: '#6d9df8',
    });
    if (!('black' in islands)) throw new Error('Islands Dark terminal palette is missing');

    const ansiColors = [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const;
    for (const color of ansiColors) {
      expect(colord(islands[color]).isValid()).toBe(true);
    }
    const foregroundContrast =
      (colord(islands.brightBlack).luminance() + 0.05) /
      (colord(islands.background).luminance() + 0.05);
    expect(foregroundContrast).toBeGreaterThanOrEqual(4.5);
    expect(getTerminalTheme('classic')).not.toHaveProperty('foreground');
    expect(root.dataset.look).toBe('classic');
  });
});

describe('getTerminalSearchDecorations', () => {
  it('resolves the active preset search tokens for xterm', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--search-match' ? '#112233' : name === '--search-match-active' ? '#445566' : '',
    }));

    expect(getTerminalSearchDecorations()).toEqual({
      matchBackground: 'rgba(17, 34, 51, 0.4)',
      matchOverviewRuler: '#112233',
      activeMatchBackground: 'rgba(68, 85, 102, 0.85)',
      activeMatchColorOverviewRuler: '#445566',
    });
  });

  it('falls back to readable search colors when custom token values are invalid', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => 'not-a-color',
    }));

    expect(getTerminalSearchDecorations()).toEqual({
      matchBackground: 'rgba(255, 213, 79, 0.4)',
      matchOverviewRuler: '#ffd54f',
      activeMatchBackground: 'rgba(255, 138, 0, 0.85)',
      activeMatchColorOverviewRuler: '#ff8a00',
    });
  });
});
