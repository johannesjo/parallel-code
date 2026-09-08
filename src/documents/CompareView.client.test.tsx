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
  mergeDocumentCandidates: vi.fn(async () => {}),
}));
import { mergeDocumentCandidates } from './store';
import { setStore } from '../store/core';
import { closeTopCompareForm } from './workspace-ui';

const disposers: Array<() => void> = [];
const KEYS = ['docws-compare:base', 'docws-compare:candidate-0', 'docws-compare:candidate-1'];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ availableAgents: [] });
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
  button(column, 'Apply 2 of 3 changes').click();
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
  expect(button(column, 'Apply 1 of 3 changes').disabled).toBe(false);
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
  expect(button(column, 'Apply 0 of 3 changes').disabled).toBe(true);
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
  expect(button(column, 'Apply 2 of 3 changes').disabled).toBe(true);
  expect(column.textContent).toContain('Preparing preview');
  finish(null);
  await vi.waitFor(() =>
    expect(column.querySelector('[role="alert"]')?.textContent).toContain(
      'cannot be combined cleanly',
    ),
  );
  expect(button(column, 'Apply 2 of 3 changes').disabled).toBe(true);
  expect(column.textContent).toContain('Preview unavailable');
  expect(acceptDocumentCandidate).not.toHaveBeenCalled();
});

it('lets an agent merge the proposals the reviewer picks', async () => {
  setStore({
    availableAgents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ],
  });
  const host = mount();
  button(host, 'Merge with agent').click();

  const panel = host.querySelector('[aria-label="Merge with agent"]');
  if (!panel) throw new Error('Merge panel did not open');
  const picks = panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(picks).toHaveLength(2);
  expect(panel.querySelector('[aria-pressed="true"]')?.textContent).toBe('Claude Code');
  const generate = button(panel, 'Generate merged version');
  expect(generate.disabled).toBe(false);

  picks[1].click();
  expect(generate.disabled).toBe(true);
  picks[1].click();
  generate.click();

  await vi.waitFor(() => expect(mergeDocumentCandidates).toHaveBeenCalled());
  const request = vi.mocked(mergeDocumentCandidates).mock.calls[0][0];
  expect(request.run.id).toBe('run-1');
  expect(request.candidateIds).toEqual(['c1', 'c2']);
  expect(request.agent.id).toBe('claude-code');
  expect(request.instruction).toContain('Combine the strongest parts');
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Merge with agent"]')).toBeNull());
});

it('keeps the merge form model-blind and lets Escape close the form alone', () => {
  setStore({
    availableAgents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ],
  });
  const host = mount();
  const escaped = vi.fn();
  document.addEventListener('keydown', escaped);
  const toggle = button(host, 'Merge with agent');
  toggle.click();

  const panel = host.querySelector('[aria-label="Merge with agent"]');
  expect(panel?.textContent).toContain('Candidate A');
  expect(panel?.textContent).not.toContain('Candidate A · Claude Code');
  host.querySelector<HTMLInputElement>('.docws-compare-bar input[type="checkbox"]')?.click();
  expect(panel?.textContent).toContain('Candidate A · Claude Code');

  // The compare dialog listens on the document; the key must not reach it.
  panel
    ?.querySelector('textarea')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(escaped).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Merge with agent"]')).toBeNull();
  expect(document.activeElement).toBe(toggle);
  document.removeEventListener('keydown', escaped);
});

it('closes an open merge form from the compare dialog before the dialog itself', () => {
  setStore({
    availableAgents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ],
  });
  const host = mount();
  button(host, 'Merge with agent').click();
  expect(host.querySelector('[aria-label="Merge with agent"]')).not.toBeNull();

  // With the focus outside the form, the dialog's Escape ends up here.
  expect(closeTopCompareForm()).toBe(true);
  expect(host.querySelector('[aria-label="Merge with agent"]')).toBeNull();
  expect(closeTopCompareForm()).toBe(false);
});

it('keeps whole-candidate acceptance when every change is selected', async () => {
  const column = await comparison();
  button(column, 'Apply proposal').click();
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
    rationale: {
      summary: 'Clarify the introduction.',
      changes: ['Explain the delivery guarantees.'],
      assumptions: [],
      questions: [],
      warnings: ['Verify delivery guarantees before publishing.'],
    },
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

function mount(candidateId?: string): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <CompareView run={run} candidateId={candidateId} />, host));
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
    button(host, 'Show all proposals').click();
    const seam = host.querySelector('.docws-columns > .resize-handle');
    const base = host.querySelector<HTMLElement>('.docws-column-base');
    if (!seam || !base) throw new Error('compare columns did not render');
    return { host, seam, base };
  }

  it('offers a seam on every column', () => {
    const host = mount();
    button(host, 'Show all proposals').click();
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
    button(host, 'Show all proposals').click();
    const seams = host.querySelectorAll('.docws-columns > .resize-handle');

    drag(seams[1], 100, 500);

    expect(getPanelUserSize('docws-compare:candidate-0')).toBeGreaterThan(260);
    expect(getPanelUserSize('docws-compare:base')).toBeUndefined();
  });
});

describe('proposal tabs', () => {
  it('shows the original and one proposal, supports keyboard switching and all-column mode', () => {
    const host = mount();
    const visible = () => host.querySelectorAll('.docws-column:not([hidden])');
    expect(visible()).toHaveLength(2);
    expect(host.querySelector('.docws-column-base')?.textContent).toContain('Original');
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector<HTMLElement>('[aria-label="Candidate A"]')?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('[aria-label="Candidate B"]')?.hidden).toBe(false);
    button(host, 'Show all proposals').click();
    expect(visible()).toHaveLength(3);
    button(host, 'Show one proposal').click();
    expect(visible()).toHaveLength(2);
    expect(host.querySelector<HTMLElement>('[aria-label="Candidate B"]')?.hidden).toBe(false);
  });

  it('opens the requested proposal and falls back to the first for an unknown id', () => {
    const host = mount('c2');
    expect(host.querySelector<HTMLElement>('[aria-label="Candidate B"]')?.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[aria-label="Candidate A"]')?.hidden).toBe(true);
    const fallback = mount('missing');
    expect(fallback.querySelector<HTMLElement>('[aria-label="Candidate A"]')?.hidden).toBe(false);
  });

  it('preserves partial acceptance and draft notes when switching proposals', async () => {
    const column = await comparison();
    const host = column.closest('.docws-compare');
    if (!host) throw new Error('Comparison did not render');
    column.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.click();
    const note = column.querySelector<HTMLTextAreaElement>('.docws-note');
    if (!note) throw new Error('Proposal note did not render');
    note.value = 'Keep this direction';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    button(host, 'Proposal B').click();
    button(host, 'Proposal A').click();
    expect(column.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.checked).toBe(false);
    expect(column.querySelector<HTMLTextAreaElement>('.docws-note')?.value).toBe(
      'Keep this direction',
    );
    await vi.waitFor(() => expect(button(column, 'Apply 2 of 3 changes').disabled).toBe(false));
  });
});

it('reveals a hidden proposal’s first change on first opening and preserves subsequent scroll', async () => {
  const column = await comparison();
  const host = column.closest('.docws-compare');
  const body = host?.querySelector<HTMLElement>('[aria-label="Candidate B"] .docws-column-body');
  if (!host || !body) throw new Error('Comparison did not render');
  await vi.waitFor(() =>
    expect(body.querySelector('.doc-block[data-change="changed"]')).not.toBeNull(),
  );
  const changed = body.querySelector<HTMLElement>('.doc-block[data-change="changed"]');
  if (!changed) throw new Error('Change did not render');
  changed.getBoundingClientRect = () => ({ top: 1000 }) as DOMRect;
  button(host, 'Proposal B').click();
  await vi.waitFor(() => expect(body.scrollTop).toBe(1000));
  body.scrollTop = 123;
  button(host, 'Proposal A').click();
  button(host, 'Proposal B').click();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(body.scrollTop).toBe(123);
});

it('collapses reasoning and notes while keeping warnings and apply controls outside the disclosure', async () => {
  const host = mount();
  const column = host.querySelector('[aria-label="Candidate A"]');
  const details = column?.querySelector<HTMLDetailsElement>('details');
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  expect(details?.querySelector('.docws-note')).not.toBeNull();
  const warning = column?.querySelector('.docws-warning');
  expect(warning?.textContent).toContain('Verify delivery guarantees');
  expect(details?.contains(warning ?? null)).toBe(false);
  const apply = button(host, 'Apply proposal');
  expect(details?.contains(apply)).toBe(false);
  expect(apply.closest('.docws-column-actions')).not.toBeNull();
  expect(column?.querySelector('.docws-column-head')?.contains(apply)).toBe(false);
});

it('navigates the original and proposal together, including deletions', async () => {
  const column = await comparison();
  const host = column.closest('.docws-compare');
  if (!host) throw new Error('Comparison missing');
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
  scroll.mockClear();
  column.querySelector<HTMLButtonElement>('[title="Next change"]')?.click();
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(scroll.mock.instances.map((el) => (el as HTMLElement).dataset.blockIndex)).toEqual([
    '1',
    '1',
  ]);
  scroll.mockClear();
  column.querySelector<HTMLButtonElement>('[title="Next change"]')?.click();
  expect(scroll.mock.instances.map((el) => (el as HTMLElement).dataset.blockIndex)).toEqual([
    '3',
    '3',
  ]);
  expect(column.textContent).toContain('2 of 3 changes');
});

it('hides unchanged markdown while retaining the anchors for deletions', async () => {
  const column = await comparison();
  const host = column.closest('.docws-compare');
  if (!host) throw new Error('Comparison missing');
  host.querySelector<HTMLInputElement>('[aria-label="Changes only"]')?.click();
  const title = column.querySelector<HTMLElement>('[data-block-index="0"]');
  expect(title?.hidden).toBe(true);
  expect(column.querySelector<HTMLElement>('[data-block-index="3"]')?.hidden).toBe(false);
  expect(host.querySelector<HTMLElement>('.docws-column-base [data-block-index="3"]')?.hidden).toBe(
    false,
  );
  host.querySelector<HTMLInputElement>('[aria-label="Changes only"]')?.click();
  expect(title?.hidden).toBe(false);
});
