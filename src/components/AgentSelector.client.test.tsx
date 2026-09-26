import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSelector } from './AgentSelector';
import type { AgentDef } from '../ipc/types';

vi.mock('../store/store', () => ({ store: { themePreset: 'dark' } }));
vi.mock('../lib/theme', () => ({ theme: {} }));

const agents: AgentDef[] = ['claude', 'kimi', 'codex'].map((command) => ({
  id: command,
  command,
  name: command,
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: command,
}));
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

function mount(docker = false, selected = agents[0]) {
  const [dockerMode, setDockerMode] = createSignal(docker);
  const [selectedAgent, setSelectedAgent] = createSignal(selected);
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <AgentSelector
          agents={agents}
          dockerMode={dockerMode()}
          selectedAgent={selectedAgent()}
          onSelect={setSelectedAgent}
        />
      ),
      container,
    ),
  );
  return { container, selectedAgent, setDockerMode };
}

describe('AgentSelector Docker-only eligibility', () => {
  it('hides Kimi from native selection and explains Docker support', () => {
    const { container } = mount();
    expect(
      Array.from(container.querySelectorAll('[role=radio]')).map((b) => b.textContent),
    ).toEqual(['claude', 'codex']);
    expect(container.textContent).toContain('Kimi Code is available in Docker mode only.');
  });

  it('retains Kimi in Docker mode', () => {
    const { container } = mount(true);
    expect(container.querySelectorAll('[role=radio]')).toHaveLength(3);
    expect(container.textContent).not.toContain('Docker mode only');
  });

  it('switches away from Kimi when Docker is disabled', () => {
    const { selectedAgent, setDockerMode, container } = mount(true, agents[1]);
    setDockerMode(false);
    expect(selectedAgent().command).toBe('claude');
    expect(container.querySelector('[aria-checked=true]')?.textContent).toBe('claude');
  });

  it('skips hidden agents during keyboard navigation', () => {
    const { selectedAgent, container } = mount();
    container
      .querySelector('button')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(selectedAgent().command).toBe('codex');
    expect(document.activeElement?.textContent).toBe('codex');
  });

  it('keeps keyboard focus correct after the Docker-only button is removed', () => {
    const { selectedAgent, container, setDockerMode } = mount(true);
    setDockerMode(false);
    container
      .querySelector('button')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(selectedAgent().command).toBe('codex');
    expect(document.activeElement?.textContent).toBe('codex');
  });
});
