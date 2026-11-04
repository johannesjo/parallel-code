import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../electron/ipc/shared-types';
import { setStore, store } from '../store/core';
import { agentsLoadFailed, loadAgents } from '../store/agents';
import { pickAndAddProject } from '../store/projects';
import { WelcomeScreen } from './WelcomeScreen';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../store/projects', () => ({ pickAndAddProject: vi.fn(async () => null) }));
vi.mock('../store/agents', () => ({
  agentsLoaded: () => true,
  agentsLoadFailed: vi.fn(() => false),
  loadAgents: vi.fn(async () => undefined),
}));

function agent(name: string, available: boolean): AgentDef {
  return {
    id: name,
    name,
    command: name,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
    available,
  };
}

let dispose = (): void => undefined;
function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const stop = render(() => <WelcomeScreen />, host);
  dispose = () => {
    stop();
    host.remove();
  };
  return host;
}

afterEach(() => {
  dispose();
  setStore('availableAgents', []);
  setStore('notification', null);
  vi.mocked(pickAndAddProject).mockReset();
  vi.mocked(loadAgents).mockClear();
  vi.mocked(agentsLoadFailed).mockReturnValue(false);
});

describe('WelcomeScreen', () => {
  it('offers linking a project as the one thing to do, with the keyboard on it', async () => {
    const host = mount();
    const button = host.querySelector<HTMLButtonElement>('.welcome-action');
    expect(host.querySelector('h1')?.textContent).toBe('Parallel Code');
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(document.activeElement).toBe(button);

    let finish: (value: null) => void = () => undefined;
    vi.mocked(pickAndAddProject).mockReturnValueOnce(new Promise((r) => (finish = r)));
    button?.click();
    expect(pickAndAddProject).toHaveBeenCalledTimes(1);
    // Busy while the folder dialog is open, so a second click opens no second dialog.
    expect(button?.disabled).toBe(true);
    finish(null);
    await vi.waitFor(() => expect(button?.disabled).toBe(false));
  });

  it('says why linking failed', async () => {
    vi.mocked(pickAndAddProject).mockRejectedValueOnce(new Error('Not a folder'));
    mount().querySelector<HTMLButtonElement>('.welcome-action')?.click();
    await vi.waitFor(() => expect(store.notification).toContain('Not a folder'));
  });

  it('names the installed agents, or says one is needed', () => {
    setStore('availableAgents', [
      agent('Claude Code', true),
      agent('Codex CLI', true),
      agent('OpenCode', true),
      agent('Gemini CLI', false),
    ]);
    const host = mount();
    const line = () => host.querySelector('.welcome-agents')?.textContent;
    expect(line()).toBe('Found Claude Code, Codex CLI and OpenCode.');
    setStore('availableAgents', [agent('Gemini CLI', false)]);
    expect(line()).toContain('No coding agent found');
  });

  it('claims nothing about agents when listing them failed', () => {
    vi.mocked(agentsLoadFailed).mockReturnValue(true);
    const line = mount().querySelector('.welcome-agents');
    expect(line?.classList.contains('pending')).toBe(true);
  });

  it('looks for agents again on returning to the window, until one is found', () => {
    mount();
    window.dispatchEvent(new Event('focus'));
    expect(loadAgents).toHaveBeenCalledTimes(1);

    setStore('availableAgents', [agent('Claude Code', true)]);
    window.dispatchEvent(new Event('focus'));
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });
});
