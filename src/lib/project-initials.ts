/**
 * Two-character stand-in for a project name, used where the full name does not
 * fit (the task bar's narrow layout). Multi-word names take the first letter of
 * the first two words ("parallel-code" -> "PC"); a single word takes its first
 * two characters ("superproductivity" -> "Su").
 */
export function projectInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const chars = Array.from(words[0]).slice(0, 2);
    return (chars[0]?.toUpperCase() ?? '') + (chars[1] ?? '');
  }
  return Array.from(words[0])[0].toUpperCase() + Array.from(words[1])[0].toUpperCase();
}
