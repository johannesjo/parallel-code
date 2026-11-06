import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomAgentEditor } from './CustomAgentEditor';
import { addCustomAgent, updateCustomAgent } from '../store/store';

vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({
    customAgents: [
      {
        id: 'custom-kimi',
        name: 'Kimi',
        command: 'kimi',
        args: ['--model', 'k2'],
        resume_args: ['--continue'],
        skip_permissions_args: [],
        description: 'Custom agent: Kimi',
      },
    ],
  });
  return {
    store,
    addCustomAgent: vi.fn(),
    updateCustomAgent: vi.fn(),
    removeCustomAgent: vi.fn(),
  };
});

let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  dispose = render(() => <CustomAgentEditor />, container);
});

afterEach(() => {
  dispose();
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function input(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  const field = found?.querySelector('input');
  if (!field) throw new Error(`no field ${label}`);
  return field;
}

function type(label: string, value: string): void {
  const field = input(label);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CustomAgentEditor', () => {
  it('shows the launch args beside the command', () => {
    expect(container.textContent).toContain('kimi --model k2');
  });

  it('edits an agent in place, prefilled, and saves it under the same id', () => {
    button('Edit Kimi').click();
    expect(input('Launch args').value).toBe('--model k2');
    expect(input('Resume args').value).toBe('--continue');

    type('Launch args', '--model k2 --yolo');
    button('Save').click();

    expect(updateCustomAgent).toHaveBeenCalledWith('custom-kimi', {
      name: 'Kimi',
      command: 'kimi',
      args: ['--model', 'k2', '--yolo'],
      resume_args: ['--continue'],
      skip_permissions_args: [],
    });
    expect(container.querySelector('input')).toBeNull();
  });

  it('cancels an edit without saving', () => {
    button('Edit Kimi').click();
    type('Command', 'other');
    button('Cancel').click();
    expect(updateCustomAgent).not.toHaveBeenCalled();
    expect(container.textContent).toContain('kimi --model k2');
  });

  it('adds an agent with an id no other custom agent has', () => {
    button('Add custom agent').click();
    type('Name', 'Kimi');
    type('Command', 'kimi-cli');
    button('Add Agent').click();
    expect(addCustomAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-kimi-2', name: 'Kimi', command: 'kimi-cli' }),
    );
  });
});
