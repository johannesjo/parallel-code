export function sf(px: number): string {
  return `calc(${px}px * var(--font-scale, 1))`;
}
