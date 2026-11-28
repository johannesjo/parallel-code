const PATH_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Undoes git's C-style quoting of a path: `"my notes.txt"`, `"caf\303\251.txt"`. */
export function unquoteGitPath(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const encoder = new TextEncoder();
  const chars = [...quoted.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (char !== '\\') {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = chars[++i] ?? '';
    if (/[0-7]/.test(next)) {
      // Octal escapes are single bytes of a UTF-8 sequence.
      bytes.push(parseInt(chars.slice(i, i + 3).join(''), 8));
      i += 2;
    } else bytes.push(PATH_ESCAPES[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}
