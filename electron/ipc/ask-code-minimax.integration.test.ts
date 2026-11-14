import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pty.js', () => ({ validateCommand: vi.fn(), ENV_BLOCK_LIST: new Set<string>() }));
vi.mock('./env-file.js', () => ({ loadEnvFile: () => ({}) }));
vi.mock('./codex-models.js', () => ({
  listCodexModels: () => [],
  defaultCodexModel: () => '',
  defaultCodexEffort: () => '',
}));

import { askAboutCode } from './ask-code.js';
import { setMinimaxApiKey } from './ask-code-minimax.js';

// Exercise the shared request router and real provider, replacing only HTTP.
describe('MiniMax request routing', () => {
  afterEach(() => {
    setMinimaxApiKey('');
    vi.unstubAllGlobals();
  });

  it.each([undefined, 'MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'custom/model-v1'])(
    'sends the selected model %s through the router to fetch',
    async (model) => {
      const fetch = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n'));
      vi.stubGlobal('fetch', fetch);
      setMinimaxApiKey('test-key');
      const send = vi.fn();
      const win = {
        isDestroyed: () => false,
        webContents: { send },
      } as unknown as BrowserWindow;
      askAboutCode(win, {
        requestId: 'route',
        channelId: 'route',
        provider: 'minimax',
        model,
        prompt: 'Return the tour JSON.',
        purpose: 'tour',
        cwd: '.',
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith('channel:route', {
          type: 'done',
          exitCode: 0,
          cancelled: false,
        }),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe('https://api.minimax.io/v1/chat/completions');
      const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.model).toBe(model ?? 'MiniMax-M3.1-Flash');
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Return the tour JSON.' });
      expect(body.messages[0].content).toContain('tour schema');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBeGreaterThan(2048);
      expect(body).not.toHaveProperty('service_tier');
    },
  );
});
