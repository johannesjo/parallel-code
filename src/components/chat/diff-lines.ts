export interface DiffLine {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  text: string;
  /** Line numbers, when the diff says where its hunks sit in the file. */
  old?: number;
  new?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff into display lines, numbering them from their hunk headers. */
export function parseDiff(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let numbered = false;
  return diff.split('\n').map((line): DiffLine => {
    const hunk = HUNK.exec(line);
    if (hunk) {
      numbered = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk', text: line };
    }
    const at = (value: number) => (numbered ? value : undefined);
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), new: at(newLine++) };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), old: at(oldLine++) };
    if (line.startsWith(' '))
      return { kind: 'context', text: line.slice(1), old: at(oldLine++), new: at(newLine++) };
    return { kind: 'note', text: line };
  });
}
