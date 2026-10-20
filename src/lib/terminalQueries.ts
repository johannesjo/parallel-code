import type { IParser } from '@xterm/xterm';

const isCursorPositionQuery = (params: (number | number[])[]) =>
  params.length === 1 && params[0] === 6;

/**
 * Stop this xterm from answering cursor-position queries (CSI 6 n, CSI ? 6 n).
 * The main process answers them for every PTY (electron/ipc/terminal-query-responder.ts),
 * including while this view is hidden or unmounted; a second answer from here would
 * reach the process as stray input.
 */
export function leaveCursorQueriesToMain(term: { parser: IParser }): void {
  term.parser.registerCsiHandler({ final: 'n' }, isCursorPositionQuery);
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, isCursorPositionQuery);
}
