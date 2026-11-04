import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

// Lezer's node type, without depending on @lezer/common directly.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolve']>;

function tableAt(state: EditorState, position: number): SyntaxNode | null {
  const line = state.doc.lineAt(position);
  const start = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
  let node: SyntaxNode | null = syntaxTree(state).resolve(start, 1);
  while (node && node.name !== 'Table') node = node.parent;
  return node;
}

/**
 * Source position at the end of a rendered cell's text, for the table whose
 * first line holds `tableFrom`. Row 0 is the header; the delimiter row has no
 * rendered row. Cells are counted by the pipes between them, since an empty
 * cell has no node of its own.
 */
export function cellEnd(
  state: EditorState,
  tableFrom: number,
  cell: { rowIndex: number; column: number },
): number {
  const table = tableAt(state, tableFrom);
  if (!table) return tableFrom;
  const rows: SyntaxNode[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push(child);
  }
  const row = rows[cell.rowIndex];
  if (!row) return table.to;
  let column = 0;
  let textEnd: number | null = null;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableCell') {
      textEnd = child.to;
    } else if (child.name === 'TableDelimiter' && child.from > row.from) {
      if (column === cell.column) return textEnd ?? child.from;
      column++;
      textEnd = null;
    }
  }
  return textEnd ?? row.to;
}
