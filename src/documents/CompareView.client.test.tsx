import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from './CompareView';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from '../store/store';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';
import { acceptDocumentCandidate } from './store';
import { IPC } from '../../electron/ipc/channels';
import * as blockMerge from './block-merge';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, args?: unknown) => Promise<unknown>>(() =>
    Promise.resolve('# Doc\n'),
  ),
}));
vi.mock('../lib/ipc', () => ({ invoke }));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  acceptDocumentCandidate: vi.fn(async () => {}),
}));

const disposers: Array<() => void> = [];
const KEYS = ['docws-compare:base', 'docws-compare:candidate-0', 'docws-compare:candidate-1'];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  deletePanelUserSize(KEYS);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  invoke.mockImplementation(() => Promise.resolve('# Doc\n'));
});

const BASE = '# Doc\n\nOriginal intro.\n\n## Keep\n\nRemove me.\n\n## End\n\nTail.\n';
const CANDIDATE = '# Doc\n\nBetter intro.\n\n## Keep\n\n## End\n\nTail.\n\nNew ending.\n';

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function comparison() {
  invoke.mockImplementation(async (channel, args) => {
    if (channel !== IPC.GetDocumentAtCommit) return '';
    return (args as { sha: string }).sha === run.baseSha ? BASE : CANDIDATE;
  });
  const host = mount();
  const column = host.querySelector('[aria-label="Candidate A"]');
  if (!column) throw new Error('Candidate A did not render');
  await vi.waitFor(() =>
    expect(column.querySelectorAll('.docws-hunk-toggle input')).toHaveLength(3),
  );
  return column;
}

it('previews retained prose, accepted deletions and insertions, then accepts that content', async () => {
  const column = await comparison();
  column.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.click();
  button(column, 'Preview result').click();
  await vi.waitFor(() => {
    const result = column.querySelector('[aria-label="Result preview"]');
    expect(result?.textContent).toContain('Original intro.');
    expect(result?.textContent).toContain('New ending.');
    expect(result?.textContent).not.toContain('Better intro.');
    expect(result?.textContent).not.toContain('Remove me.');
  });
  button(column, 'Accept 2 of 3 changes').click();
  await vi.waitFor(() =>
    expect(acceptDocumentCandidate).toHaveBeenCalledWith('run-1', 'c1', {
      content: '# Doc\n\nOriginal intro.\n\n## Keep\n\n## End\n\nTail.\n\nNew ending.\n',
      accepted: 2,
      total: 3,
    }),
  );
});

it('preserves choices when returning to changes and refreshes the preview after another choice', async () => {
  const column = await comparison();
  column.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.click();
  button(column, 'Preview result').click();
  await vi.waitFor(() =>
    expect(column.querySelector('[aria-label="Result preview"]')?.textContent).toContain(
      'Original intro.',
    ),
  );
  button(column, 'Back to changes').click();
  const toggles = column.querySelectorAll<HTMLInputElement>('.docws-hunk-toggle input');
  expect(toggles[0].checked).toBe(false);
  toggles[1].click();
  button(column, 'Preview result').click();
  await vi.waitFor(() =>
    expect(column.querySelector('[aria-label="Result preview"]')?.textContent).toContain(
      'Remove me.',
    ),
  );
  expect(button(column, 'Accept 1 of 3 changes').disabled).toBe(false);
});

it('shows the base when every change is declined and prevents accepting nothing', async () => {
  const column = await comparison();
  column
    .querySelectorAll<HTMLInputElement>('.docws-hunk-toggle input')
    .forEach((input) => input.click());
  button(column, 'Preview result').click();
  await vi.waitFor(() => {
    const result = column.querySelector('[aria-label="Result preview"]');
    expect(result?.textContent).toContain('Original intro.');
    expect(result?.textContent).toContain('Remove me.');
    expect(result?.textContent).not.toContain('New ending.');
  });
  expect(button(column, 'Accept 0 of 3 changes').disabled).toBe(true);
});

it('disables acceptance while composing and reports a failed composition', async () => {
  const column = await comparison();
  let finish: (value: null) => void = () => {};
  vi.spyOn(blockMerge, 'composeVerifiedDocument').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  column.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.click();
  button(column, 'Preview result').click();
  expect(button(column, 'Accept 2 of 3 changes').disabled).toBe(true);
  expect(column.textContent).toContain('Preparing preview');
  finish(null);
  await vi.waitFor(() =>
    expect(column.querySelector('[role="alert"]')?.textContent).toContain(
      'cannot be combined cleanly',
    ),
  );
  expect(button(column, 'Accept 2 of 3 changes').disabled).toBe(true);
  expect(column.textContent).toContain('Preview unavailable');
  expect(acceptDocumentCandidate).not.toHaveBeenCalled();
});

it('keeps whole-candidate acceptance when every change is selected', async () => {
  const column = await comparison();
  button(column, 'Accept this candidate').click();
  await vi.waitFor(() => expect(acceptDocumentCandidate).toHaveBeenCalledWith('run-1', 'c1'));
});

function candidate(id: string, label: string): DocumentCandidateRecord {
  return {
    id,
    label,
    agentId: 'claude',
    agentName: 'Claude Code',
    isMain: label === 'A',
    branch: `docws/${id}`,
    worktreePath: `/tmp/${id}`,
    status: 'done',
    commitSha: `sha-${id}`,
    startedAt: new Date(0).toISOString(),
  };
}

const run: DocumentRunRecord = {
  version: 1,
  id: 'run-1',
  documentPath: 'doc.md',
  createdAt: new Date(0).toISOString(),
  instruction: 'Tighten the intro',
  scope: { path: 'doc.md', wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
  baseSha: 'abcdef1234',
  status: 'finished',
  candidates: [candidate('c1', 'A'), candidate('c2', 'B')],
};

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <CompareView run={run} />, host));
  return host;
}

function drag(seam: Element, from: number, to: number): void {
  seam.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from }));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }));
  window.dispatchEvent(new MouseEvent('mouseup'));
}

describe('CompareView columns', () => {
  /** happy-dom lays nothing out, so a column reports the width it is given. */
  function widen(column: Element, width: number): void {
    column.getBoundingClientRect = () => ({ width }) as DOMRect;
  }

  function columns(): { host: HTMLElement; seam: Element; base: HTMLElement } {
    const host = mount();
    const seam = host.querySelector('.docws-columns > .resize-handle');
    const base = host.querySelector<HTMLElement>('.docws-column-base');
    if (!seam || !base) throw new Error('compare columns did not render');
    return { host, seam, base };
  }

  it('offers a seam on every column', () => {
    const host = mount();
    expect(host.querySelectorAll('.docws-columns > .resize-handle')).toHaveLength(3);
  });

  it('sizes the column its seam sits behind, starting from that column\u2019s width', () => {
    const { seam, base } = columns();
    widen(base, 300);

    drag(seam, 100, 200);

    expect(getPanelUserSize('docws-compare:base')).toBe(400);
    expect(base.style.minWidth).toBe('400px');
    expect(base.style.maxWidth).toBe('400px');
  });

  it('follows the pointer live but saves the width only on release', () => {
    const { seam, base } = columns();
    widen(base, 300);

    seam.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 250 }));

    expect(base.style.minWidth).toBe('450px');
    expect(getPanelUserSize('docws-compare:base')).toBeUndefined();

    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(getPanelUserSize('docws-compare:base')).toBe(450);
  });

  it('stops following the pointer once the button is up', () => {
    const { seam, base } = columns();
    widen(base, 300);
    drag(seam, 100, 200);

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));

    expect(getPanelUserSize('docws-compare:base')).toBe(400);
    expect(base.style.minWidth).toBe('400px');
  });

  it('opens on a width the reader saved earlier', () => {
    setPanelUserSize('docws-compare:base', 512);

    const { base } = columns();

    expect(base.style.minWidth).toBe('512px');
  });

  it('gives the width back to the layout on double-click', () => {
    const { seam, base } = columns();
    widen(base, 300);
    drag(seam, 100, 200);

    seam.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(getPanelUserSize('docws-compare:base')).toBeUndefined();
    expect(base.style.minWidth).toBe('');
  });

  it('never sizes a column below what still reads', () => {
    const { seam, base } = columns();
    widen(base, 300);

    drag(seam, 600, 0);

    expect(getPanelUserSize('docws-compare:base')).toBe(260);
  });

  it('leaves the columns alone on a right-button press', () => {
    const { seam, base } = columns();
    widen(base, 300);

    seam.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, button: 2 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(getPanelUserSize('docws-compare:base')).toBeUndefined();
    expect(base.style.minWidth).toBe('');
  });

  it('sizes a candidate column from its own seam', () => {
    const host = mount();
    const seams = host.querySelectorAll('.docws-columns > .resize-handle');

    drag(seams[1], 100, 500);

    expect(getPanelUserSize('docws-compare:candidate-0')).toBeGreaterThan(260);
    expect(getPanelUserSize('docws-compare:base')).toBeUndefined();
  });
});
