export interface DiffLine {
  /** New-file line for added lines, old-file line for removed lines. */
  line: number;
  text: string;
}

export interface ParsedHunks {
  added: DiffLine[];
  removed: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;

/** Reads the +/- lines of one file's patch. Anything before the first hunk is ignored. */
export function parseHunks(patch: string): ParsedHunks {
  const result: ParsedHunks = { added: [], removed: [] };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (!inHunk || raw.startsWith('\\')) {
      continue;
    } else if (raw.startsWith('+')) {
      result.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      result.removed.push({ line: oldLine++, text: raw.slice(1) });
    } else {
      oldLine++;
      newLine++;
    }
  }
  return result;
}

const TITLE_CALL =
  /(?<![\w$.])(?:test\.describe|describe|it|test)(?:\.(?:only|skip|todo|fixme|concurrent|serial|parallel|fail|slow))*\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`)/;

/** Title of a describe/it/test call on this line, if its first argument is a plain string. */
export function extractTitle(text: string): string | undefined {
  const match = TITLE_CALL.exec(text);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Small non-cryptographic hash (cyrb53) so flag ids stay stable without Node imports. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
