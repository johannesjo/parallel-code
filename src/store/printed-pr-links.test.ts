import { describe, expect, it } from 'vitest';
import { forgetPrintedPrLink, notePrintedPrLink, printedPrLink } from './printed-pr-links';

const url = 'https://github.com/acme/app/pull/12';

describe('notePrintedPrLink', () => {
  it('notices a PR link split across PTY chunks', () => {
    const before = printedPrLink();
    notePrintedPrLink('agent-split', 'task-1', {
      tail: 'Creating pull request\r\nhttps://github.com/acme/ap',
      chunk: 'https://github.com/acme/ap',
    });
    expect(printedPrLink()).toBe(before);

    const tail = `Creating pull request\r\n${url}\r\n`;
    notePrintedPrLink('agent-split', 'task-1', { tail, chunk: 'p/pull/12\r\n' });
    expect(printedPrLink()).toEqual({ taskId: 'task-1', url });
  });

  it('ignores a repaint of a link it already noticed', () => {
    const output = { tail: `${url}\r\n`, chunk: `${url}\r\n` };
    notePrintedPrLink('agent-repaint', 'task-2', output);
    const first = printedPrLink();
    notePrintedPrLink('agent-repaint', 'task-2', output);
    expect(printedPrLink()).toBe(first);
  });

  it('notices a link again once its agent is gone', () => {
    const output = { tail: `${url}\r\n`, chunk: `${url}\r\n` };
    notePrintedPrLink('agent-restart', 'task-4', output);
    const first = printedPrLink();
    forgetPrintedPrLink('agent-restart');
    notePrintedPrLink('agent-restart', 'task-4', output);
    expect(printedPrLink()).not.toBe(first);
  });

  it('ignores links that are not pull requests', () => {
    const before = printedPrLink();
    const issue = 'https://github.com/acme/app/issues/3\r\n';
    notePrintedPrLink('agent-issue', 'task-3', { tail: issue, chunk: issue });
    expect(printedPrLink()).toBe(before);
  });
});
