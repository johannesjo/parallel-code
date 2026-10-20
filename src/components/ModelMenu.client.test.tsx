import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelMenu } from './ModelMenu';

let dispose: (() => void) | undefined;
const [choices, setChoices] = createSignal([{ value: 'sonnet', label: 'sonnet' }]);

afterEach(() => {
  setChoices([{ value: 'sonnet', label: 'sonnet' }]);
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(withSection: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <ModelMenu
        label="Model"
        value="sonnet"
        onSelect={vi.fn()}
        groups={[{ heading: 'Claude Code', choices: choices() }]}
        section={
          withSection
            ? {
                heading: 'Reasoning',
                choices: [{ value: 'high', label: 'High' }],
                value: 'high',
                onSelect: vi.fn(),
              }
            : undefined
        }
      />
    ),
    host,
  );
  return host.querySelector('button') as HTMLButtonElement;
}

/** A trigger near the window's bottom, so the menu opens upwards. */
function openNearBottom(trigger: HTMLButtonElement, menuHeight: () => number) {
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(400, window.innerHeight - 40, 100, 20),
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'menu' ? menuHeight() : 0;
  });
  trigger.click();
  return document.querySelector<HTMLElement>('[role="menu"]');
}

it('opens upwards flush with the trigger, whatever the menu holds', () => {
  const trigger = mount(true);
  const menu = openNearBottom(trigger, () => 300);
  // 2px gap above the trigger; 2px for the menu's border.
  expect(menu?.style.top).toBe(`${window.innerHeight - 40 - 2 - 302}px`);
});

it('stays flush with the trigger when choices arrive while it is open', () => {
  let height = 100;
  const trigger = mount(true);
  const menu = openNearBottom(trigger, () => height);
  height = 300;
  setChoices((list) => [...list, { value: 'opus', label: 'opus' }]);
  expect(menu?.style.top).toBe(`${window.innerHeight - 40 - 2 - 302}px`);
});

it('labels each set of choices as its own group', () => {
  mount(true).click();
  const groups = [...document.querySelectorAll('[role="group"]')];
  expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
    'Claude Code',
    'Reasoning',
  ]);
  expect(groups.map((group) => group.querySelectorAll('[aria-checked="true"]').length)).toEqual([
    1, 1,
  ]);
});
