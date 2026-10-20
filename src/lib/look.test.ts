import { describe, it, expect } from 'vitest';
import {
  LOOK_PRESETS,
  presetsForTone,
  defaultPresetForTone,
  isLightPreset,
  isLookPreset,
} from './look';

describe('presetsForTone', () => {
  it('returns only dark presets for tone dark', () => {
    const dark = presetsForTone('dark');
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.every((p) => p.tone === 'dark')).toBe(true);
  });

  it('returns only light presets for tone light', () => {
    const light = presetsForTone('light');
    expect(light.length).toBeGreaterThan(0);
    expect(light.every((p) => p.tone === 'light')).toBe(true);
  });

  it('dark + light covers every preset exactly once', () => {
    const all = [...presetsForTone('dark'), ...presetsForTone('light')];
    expect(all.length).toBe(LOOK_PRESETS.length);
    expect(new Set(all.map((p) => p.id)).size).toBe(LOOK_PRESETS.length);
  });

  it('offers Obsidian Light first, then Islands Light', () => {
    const light = presetsForTone('light');
    expect(light.map((p) => p.id)).toEqual(['obsidian-light', 'islands-light']);
  });
});

describe('defaultPresetForTone', () => {
  it('returns obsidian-light for light', () => {
    expect(defaultPresetForTone('light')).toBe('obsidian-light');
  });

  it('returns obsidian for dark', () => {
    expect(defaultPresetForTone('dark')).toBe('obsidian');
  });
});

describe('isLightPreset', () => {
  it('follows each preset tone', () => {
    for (const preset of LOOK_PRESETS) {
      expect(isLightPreset(preset.id)).toBe(preset.tone === 'light');
    }
  });

  it('treats unknown or missing ids as dark', () => {
    expect(isLightPreset('custom')).toBe(false);
    expect(isLightPreset(undefined)).toBe(false);
  });
});

describe('isLookPreset', () => {
  it('returns true for every known preset id', () => {
    for (const preset of LOOK_PRESETS) {
      expect(isLookPreset(preset.id)).toBe(true);
    }
  });

  it('returns false for an unknown string', () => {
    expect(isLookPreset('not-a-theme')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isLookPreset(null)).toBe(false);
    expect(isLookPreset(undefined)).toBe(false);
    expect(isLookPreset(42)).toBe(false);
    expect(isLookPreset({})).toBe(false);
  });
});
