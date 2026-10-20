import { afterEach, expect, it, vi } from 'vitest';
import { exportReasoningGraph } from './export';
import type { Snapshot } from './state';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('exports a fitted offline canvas and complete graph data without interpreting note text as HTML', async () => {
  vi.useFakeTimers();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const group = document.createElementNS(svg.namespaceURI, 'g');
  group.setAttribute('transform', 'translate(500,500) scale(.2)');
  Object.assign(group, { getBBox: () => ({ x: -100, y: -30, width: 400, height: 200 }) });
  svg.append(group);
  const title = document.createElementNS(svg.namespaceURI, 'text');
  title.textContent = '<script>alert(1)</script>';
  group.append(title);
  const snapshot: Snapshot = {
    version: 1,
    revision: 2,
    sequence: 1,
    caption: 'Saved',
    records: [
      {
        id: 'goal',
        kind: 'goal',
        title: 'Graph / test',
        detail: '<img src=x onerror=alert(1)>',
        status: 'unresolved',
      },
      {
        id: 'hidden',
        parent: 'goal',
        kind: 'question',
        title: 'Collapsed child',
        detail: 'Still exported',
        status: 'unresolved',
      },
    ],
    relations: [],
    explanations: [{ id: 'answer', nodeId: 'goal', question: 'Why?', answer: 'Evidence.' }],
  };
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob;
    return 'blob:export';
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
  document.body.append(svg);
  svg.style.setProperty('--task-panel-bg', 'rgb(20, 20, 30)');
  svg.style.setProperty('--fg', 'rgb(230, 230, 240)');
  exportReasoningGraph(svg, snapshot, new Date(2026, 8, 15, 10, 30));
  svg.remove();
  expect(filename).toBe('Graph-test.html');
  const html = await blob?.text();
  expect(html).toContain('background:rgb(20, 20, 30)');
  expect(html).toContain('color:rgb(230, 230, 240)');
  expect(html).toContain('Revision 2 · Saved · ');
  expect(html).toContain('viewBox="-124 -54 448 248"');
  expect(html).not.toContain('translate(500');
  const saved = new DOMParser().parseFromString(html ?? '', 'text/html');
  expect(saved.querySelector('script, img')).toBeNull();
  expect(saved.querySelector('svg')?.style.position).toBe('static');
  expect(JSON.parse(saved.querySelector('pre')?.textContent ?? '{}').snapshot).toEqual(snapshot);
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledWith('blob:export');
  expect(document.querySelector('a[download]')).toBeNull();
});
