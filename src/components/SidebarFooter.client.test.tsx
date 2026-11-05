import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));

import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { getLocalDateKey } from '../lib/date';
import { setStore, store } from '../store/core';
import { SidebarFooter } from './SidebarFooter';

const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  // happy-dom lays nothing out; the tip needs its anchor to have a box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(20, 600, 200, 24),
  );
  setStore('featureHintsEnabled', true);
  setStore('seenFeatureHints', []);
  setStore('showSidebarProgress', true);
  setStore('completedTaskDate', getLocalDateKey());
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.runAllTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountWithMergesToday(count: number): void {
  setStore('completedTaskCount', count);
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <SidebarFooter onConnectPhone={() => {}} />, host));
  // The tip waits a moment once it could show.
  vi.advanceTimersByTime(650);
}

const starTip = () =>
  [...document.querySelectorAll<HTMLElement>('[role="note"]')].find((n) =>
    n.textContent?.includes('Star on GitHub'),
  );
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label);

describe('SidebarFooter star request', () => {
  it('waits for the third merge of the day', () => {
    mountWithMergesToday(2);
    expect(starTip()).toBeUndefined();
  });

  it('asks once after three merges today and opens the repository when taken', () => {
    mountWithMergesToday(3);
    expect(starTip()?.textContent).toContain('A productive day');

    button('Star on GitHub')?.click();
    expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, {
      url: 'https://github.com/johannesjo/parallel-code',
    });
    expect(store.seenFeatureHints).toEqual(['github-star']);
    expect(starTip()).toBeUndefined();
  });

  it('never asks again once declined', () => {
    mountWithMergesToday(3);
    button('No thanks')?.click();
    expect(store.seenFeatureHints).toEqual(['github-star']);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ShellOpenExternal, expect.anything());
    expect(starTip()).toBeUndefined();
  });
});

describe('SidebarFooter contribute entry', () => {
  it('opens the contribute dialog, with or without sidebar tips', () => {
    setStore('showSidebarTips', false);
    mountWithMergesToday(0);

    button('Contribute')?.click();

    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(
      'Contribute to Parallel Code',
    );
  });
});
