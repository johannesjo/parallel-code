export type LookPreset = 'warp';

export const LOOK_PRESETS = [
  { id: 'warp' as const, label: 'Warp', description: 'Dark theme with purple accents' },
];

export function isLookPreset(value: unknown): value is LookPreset {
  return value === 'warp';
}
