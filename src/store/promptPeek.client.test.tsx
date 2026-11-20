import { createRoot, createSignal } from 'solid-js';
import { expect, it, vi } from 'vitest';
import { parsePromptMenu } from '../../electron/shared/prompt-menu';
import { invoke } from '../lib/ipc';
import { createPromptPeek } from './promptPeek';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./tasks', () => ({ sendPrompt: vi.fn() }));
vi.mock('./agentHookStatus', () => ({ noteAgentTerminalInput: vi.fn() }));

const MENU = parsePromptMenu([' Trust this folder?', ' ❯ 1. Yes', '   2. No'].join('\n'));

it('keeps the dialog it read while unrelated state behind the agent id changes', async () => {
  vi.mocked(invoke).mockResolvedValue({ menu: MENU, tail: [] });
  const [tick, setTick] = createSignal(0);
  await createRoot(async (dispose) => {
    const peek = createPromptPeek(() => (tick() >= 0 ? 'agent' : undefined));
    await vi.waitFor(() => expect(peek()?.menu).toEqual(MENU));
    const reads = vi.mocked(invoke).mock.calls.length;
    setTick(1);
    // Same agent: no blank frame and no fresh read.
    expect(peek()?.menu).toEqual(MENU);
    expect(vi.mocked(invoke).mock.calls.length).toBe(reads);
    dispose();
  });
});
