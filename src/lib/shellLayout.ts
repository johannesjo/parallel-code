/** How a task's plain shell terminals are arranged. */
export type ShellLayoutMode = 'row' | 'grid' | 'column';

export const SHELL_LAYOUT_MODES: readonly ShellLayoutMode[] = ['row', 'grid', 'column'];

/** Narrowest a shell may get in the split layout's side column (~48 chars). */
const SHELL_MIN_WIDTH = 350;

// A mode is kept until the width drops this far below its threshold, so
// dragging the column divider across a threshold doesn't flicker.
const HYSTERESIS_PX = 30;

export function isShellLayoutMode(value: unknown): value is ShellLayoutMode {
  return value === 'row' || value === 'grid' || value === 'column';
}

export interface AutoShellLayoutInput {
  /** Width of the shell area in px. */
  width: number;
  count: number;
  /** True when the task renders its two-column split layout. */
  split: boolean;
  /** The mode chosen last time, for hysteresis; none on the first measurement. */
  prev?: ShellLayoutMode;
}

/** Picks the widest arrangement that keeps every shell at least
 *  `SHELL_MIN_WIDTH` wide. Outside the split layout shells always sit side by
 *  side: the height there belongs to the agent terminal. */
export function autoShellLayout(input: AutoShellLayoutInput): ShellLayoutMode {
  const { width, count, split, prev } = input;
  if (!split || count < 2) return 'row';
  const fits = (mode: ShellLayoutMode, perRow: number) => {
    const need = perRow * SHELL_MIN_WIDTH;
    return width >= need || (prev === mode && width >= need - HYSTERESIS_PX);
  };
  if (fits('row', count)) return 'row';
  // Two shells in a square grid are a row; keep the name the user sees honest.
  if (fits('grid', shellColumns('grid', count))) return count <= 2 ? 'row' : 'grid';
  return 'column';
}

/** Shells per row: Row puts all side by side, Square grid uses ⌈√n⌉ columns. */
export function shellColumns(mode: ShellLayoutMode, count: number): number {
  if (count < 1) return 1;
  if (mode === 'row') return count;
  if (mode === 'grid') return Math.ceil(Math.sqrt(count));
  return 1;
}
