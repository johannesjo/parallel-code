import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResumeWithFlags } from './resume-with-flags';
import { resumeAgentWithFlags } from '../store/agents';

vi.mock('../store/agents', () => ({ resumeAgentWithFlags: vi.fn() }));
vi.mock('../store/core', () => ({
  store: {
    agents: {
      'agent-1': {
        def: { name: 'Claude Code', resume_args: ['--continue'], extra_args: ['--model', 'opus'] },
      },
    },
  },
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
  vi.mocked(resumeAgentWithFlags).mockReset();
});

function openDialog(): HTMLInputElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => {
    const flags = createResumeWithFlags(() => 'agent-1');
    flags.open();
    return <flags.Dialog />;
  }, host);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Extra flags"]');
  if (!input) throw new Error('flags input missing');
  return input;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`${label} button missing`);
  return found;
}

describe('Resume with flags dialog', () => {
  it('starts from the flags the pane already has', () => {
    expect(openDialog().value).toBe('--model opus');
  });

  it('resumes with the typed flags split on whitespace', () => {
    type(openDialog(), '  --chrome   --model opus ');
    button('Resume').click();

    expect(resumeAgentWithFlags).toHaveBeenCalledWith('agent-1', ['--chrome', '--model', 'opus']);
  });

  it('clears the flags when the field is emptied', () => {
    const input = openDialog();
    type(input, '');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(resumeAgentWithFlags).toHaveBeenCalledWith('agent-1', []);
  });

  it('changes nothing on cancel', () => {
    type(openDialog(), '--chrome');
    button('Cancel').click();

    expect(resumeAgentWithFlags).not.toHaveBeenCalled();
    expect(document.querySelector('input[aria-label="Extra flags"]')).toBeNull();
  });
});
