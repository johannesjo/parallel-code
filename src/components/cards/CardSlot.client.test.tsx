import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotValue } from '../../lib/card-slots';
import { CardSlot } from './CardSlot';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('CardSlot text', () => {
  it('confirms a copy, then offers to copy again', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'note', type: 'text', label: 'Note' }}
          value={{ type: 'text', text: 'Ship it' }}
        />
      ),
      document.body,
    );
    const button = () => document.body.querySelector('button');
    button()?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('Ship it');
    expect(button()?.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button()?.textContent).toBe('Copy');
  });
});

describe('CardSlot before it has a value', () => {
  const show = (showLabel: boolean) => {
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'risks', type: 'items', label: 'Risks' }}
          value={undefined}
          showLabel={showLabel}
        />
      ),
      document.body,
    );
  };

  it('holds its place with a dash under its label', () => {
    show(true);
    expect(document.body.querySelector('.slot')?.textContent).toBe('Risks–');
  });

  it('says so in words when it has no label to explain a dash', () => {
    show(false);
    expect(document.body.querySelector('.slot')?.textContent).toBe('Nothing yet');
  });
});

describe('CardSlot lists', () => {
  it('says None for a list that found nothing, not the empty placeholder', () => {
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'risks', type: 'items', label: 'Risks' }}
          value={{ type: 'items', items: [] }}
        />
      ),
      document.body,
    );
    expect(document.body.querySelector('.card-empty')?.textContent).toBe('None');
    expect(document.body.querySelector('.slot-placeholder')).toBeNull();
  });
});

describe('CardSlot items', () => {
  const show = (item: { text: string; file?: string; turn?: number }) => {
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'look', type: 'items', label: 'Look at' }}
          value={{ type: 'items', items: [{ severity: 'info', ...item }] }}
          showLabel={false}
        />
      ),
      document.body,
    );
  };

  it('puts the file in full under the text, not in the tag beside it', () => {
    show({ text: 'Timeout is fixed', file: 'src/components/settings/cards/CardSlotsEditor.tsx' });
    expect(document.body.querySelector('.slot-row-text .slot-item-file')?.textContent).toBe(
      'src/components/settings/cards/CardSlotsEditor.tsx',
    );
    expect(document.body.querySelector('.slot-item-tag')).toBeNull();
  });

  it('tags an item without a file with its turn', () => {
    show({ text: 'Backoff caps at 30 s', turn: 3 });
    expect(document.body.querySelector('.slot-item-tag')?.textContent).toBe('turn 3');
  });

  it('leaves out the label where the card name already says it', () => {
    show({ text: 'Backoff caps at 30 s' });
    expect(document.body.querySelector('.slot-label')).toBeNull();
  });
});

describe('CardSlot when its value changes', () => {
  const NOTE = { id: 'now', type: 'line', label: 'Now' } as const;
  const line = (text: string): SlotValue => ({ type: 'line', text });
  const show = (first: SlotValue | undefined) => {
    const [value, setValue] = createSignal(first);
    dispose = render(() => <CardSlot slot={NOTE} value={value()} />, document.body);
    return setValue;
  };
  const flashed = () => document.body.querySelector('.slot')?.hasAttribute('data-flash');

  it('does not flash the values it opens with', () => {
    show(line('Write the migration'));
    expect(flashed()).toBe(false);
  });

  it('flashes a value that changed, so a pane left open shows what is new', () => {
    const setValue = show(line('Write the migration'));
    setValue(line('Run the tests'));
    expect(flashed()).toBe(true);
  });

  it('flashes a first value arriving', () => {
    const setValue = show(undefined);
    setValue(line('Write the migration'));
    expect(flashed()).toBe(true);
  });

  it('stays still when a run returns the same value again', () => {
    const setValue = show(line('Write the migration'));
    setValue(line('Write the migration'));
    expect(flashed()).toBe(false);
  });
});

describe('CardSlot add-up lists', () => {
  it('shows fewer again after showing every earlier item', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((text) => ({
      text,
      severity: 'info' as const,
    }));
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'log', type: 'items', label: 'Log', addUp: true }}
          value={{ type: 'items', items }}
        />
      ),
      document.body,
    );
    const rows = () => document.body.querySelectorAll('.slot-row-text').length;
    const button = () => document.body.querySelector<HTMLButtonElement>('.slot-list button');
    expect(rows()).toBe(4);
    expect(button()?.textContent).toBe('+ 2 earlier');
    button()?.click();
    expect(rows()).toBe(6);
    expect(button()?.textContent).toBe('Show fewer');
    button()?.click();
    expect(rows()).toBe(4);
  });
});

describe('CardSlot status rows', () => {
  it('spins for a row still running, as the card head does', () => {
    dispose = render(
      () => (
        <CardSlot
          slot={{ id: 'ci', type: 'status', label: 'CI' }}
          value={{ type: 'status', rows: [{ state: 'running', text: 'Unit tests' }] }}
        />
      ),
      document.body,
    );
    expect(document.body.querySelector('li .slot-mark .status-glyph-spinner')).not.toBeNull();
  });
});
