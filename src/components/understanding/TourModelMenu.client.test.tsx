import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TourModelMenu } from './TourModelMenu';

const { setAskCodeProvider, setAskCodeModel, invoke, CODEX_MODELS } = vi.hoisted(() => {
  const CODEX_MODELS = [
    { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna' },
    { slug: 'gpt-5.5', displayName: 'GPT-5.5' },
  ];
  return {
    CODEX_MODELS,
    setAskCodeProvider: vi.fn(),
    setAskCodeModel: vi.fn(),
    invoke: vi.fn(() => Promise.resolve(CODEX_MODELS)),
  };
});

vi.mock('../../store/store', () => ({ setAskCodeProvider, setAskCodeModel }));
vi.mock('../../lib/ipc', () => ({ invoke }));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

/** The Codex rows arrive from the backend, so the first open resolves a promise. */
async function openMenu(trigger: HTMLButtonElement): Promise<void> {
  trigger.click();
  await vi.waitFor(() => expect(items()).toHaveLength(4 + CODEX_MODELS.length + 2));
}

function mount(): HTMLButtonElement {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <TourModelMenu />, container));
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('No trigger rendered');
  return trigger;
}

const items = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));

describe('TourModelMenu', () => {
  it('offers every model with the current one checked', async () => {
    const trigger = mount();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The default store setting, named on the trigger before the menu opens.
    expect(trigger.title).toBe('Model: Claude Code · sonnet');
    expect(items()).toHaveLength(0);

    await openMenu(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(items().map((item) => item.textContent?.trim())).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'GPT-5.6-Luna',
      'GPT-5.5',
      'MiniMax-M3.1-Flash',
      'MiniMax-M3',
    ]);
    expect(
      items()
        .filter((item) => item.getAttribute('aria-checked') === 'true')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['sonnet']);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Tour model');
  });

  it('closes on Escape and hands the focus back to the trigger', async () => {
    const trigger = mount();
    trigger.focus();
    await openMenu(trigger);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('sets the provider and model together when M3 is picked', async () => {
    const trigger = mount();
    await openMenu(trigger);
    items()[items().length - 1].click();

    expect(setAskCodeProvider).toHaveBeenCalledExactlyOnceWith('minimax');
    expect(setAskCodeModel).toHaveBeenCalledExactlyOnceWith('MiniMax-M3');
    expect(items()).toHaveLength(0);
  });

  it('sets provider and alias together when a Claude model is picked', async () => {
    const trigger = mount();
    await openMenu(trigger);
    items()[1].click();

    expect(setAskCodeProvider).toHaveBeenCalledExactlyOnceWith('claude');
    expect(setAskCodeModel).toHaveBeenCalledExactlyOnceWith('opus');
  });

  it('lists the Codex models the CLI reported, by display name over slug', async () => {
    const trigger = mount();
    await openMenu(trigger);

    const codex = items()[4];
    expect(codex.textContent?.trim()).toBe('GPT-5.6-Luna');
    // The slug is what reaches the CLI, so hovering the row shows it.
    expect(codex.title).toBe('gpt-5.6-luna');
    codex.click();

    expect(setAskCodeProvider).toHaveBeenCalledExactlyOnceWith('codex');
    expect(setAskCodeModel).toHaveBeenCalledExactlyOnceWith('gpt-5.6-luna');
  });

  it('walks the items with the arrow keys', async () => {
    const trigger = mount();
    await openMenu(trigger);
    items()[0].focus();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items()[1]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);
  });
});
