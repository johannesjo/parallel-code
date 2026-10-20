/**
 * Direct relative imports of one source file, in source order.
 *
 * File tours inline a file plus what it imports, so the parser only needs the
 * specifiers a reader would follow: static `import`/`export ... from`, bare
 * side-effect imports (how CSS arrives), dynamic `import()`, and `require()`.
 * Bare package specifiers are ignored — only `./` and `../` are worth reading.
 *
 * Regex, not a real parser: a specifier inside a comment or a string costs one
 * wasted resolution attempt, which the caller already tolerates.
 */
const IMPORT_PATTERNS: RegExp[] = [
  // `import x from 's'`, `import type { X } from 's'`, `export { x } from 's'`
  /\b(?:import|export)\s[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // `import 's'` — side-effect only, no bindings
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

export function parseRelativeImports(source: string): string[] {
  const hits: { index: number; spec: string }[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec === undefined || !isRelative(spec)) continue;
      hits.push({ index: match.index ?? 0, spec });
    }
  }
  hits.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const specs: string[] = [];
  for (const { spec } of hits) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}
