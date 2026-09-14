import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above the module body, so the spies they
// close over have to be hoisted with them.
const { mockSpawn, mockAskMinimax } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockAskMinimax: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('./pty.js', () => ({ validateCommand: vi.fn(), ENV_BLOCK_LIST: new Set<string>() }));
vi.mock('./env-file.js', () => ({ loadEnvFile: vi.fn(() => ({})) }));

vi.mock('./ask-code-minimax.js', () => ({
  askAboutCodeMinimax: (...args: unknown[]) => mockAskMinimax(...args),
  cancelAskAboutCodeMinimax: vi.fn(),
  isMinimaxRequestActive: vi.fn(() => false),
}));

import { askAboutCode } from './ask-code.js';

function makeMockProc() {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function makeMockWin() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as Parameters<typeof askAboutCode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawn.mockImplementation(() => makeMockProc());
});

describe('askAboutCode provider routing', () => {
  it('drops imagePaths on the claude CLI path instead of passing them through', () => {
    askAboutCode(makeMockWin(), {
      requestId: 'claude-img',
      channelId: 'ch-claude-img',
      prompt: 'What does this do?',
      cwd: '/repo',
      provider: 'claude',
      imagePaths: ['/tmp/shot.png'],
    });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, argv] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('claude');
    // The CLI takes a text prompt only — an image path must never reach argv.
    expect(argv).toContain('What does this do?');
    expect(argv.join(' ')).not.toContain('/tmp/shot.png');
    expect(mockAskMinimax).not.toHaveBeenCalled();
  });

  it('forwards imagePaths to the minimax backend without spawning the CLI', () => {
    askAboutCode(makeMockWin(), {
      requestId: 'minimax-img',
      channelId: 'ch-minimax-img',
      prompt: 'What does this show?',
      cwd: '/repo',
      provider: 'minimax',
      imagePaths: ['/tmp/shot.png'],
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAskMinimax).toHaveBeenCalledWith(expect.anything(), {
      requestId: 'minimax-img',
      channelId: 'ch-minimax-img',
      prompt: 'What does this show?',
      imagePaths: ['/tmp/shot.png'],
    });
  });
});
