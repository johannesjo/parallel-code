import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MINIMAX_MODEL_ID,
  DEFAULT_MINIMAX_REGION,
  MINIMAX_ENDPOINTS,
  MINIMAX_MODELS,
  getMinimaxEndpoint,
  getMinimaxModel,
  minimaxBaseUrl,
  minimaxChatCompletionsUrl,
  minimaxModelIds,
} from './minimax-catalog.js';

describe('minimax catalog models', () => {
  it('retains M2.7 alongside M3', () => {
    expect(minimaxModelIds()).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
  });

  it('defaults to M3', () => {
    expect(DEFAULT_MINIMAX_MODEL_ID).toBe('MiniMax-M3');
    expect(getMinimaxModel(DEFAULT_MINIMAX_MODEL_ID)).toBeDefined();
  });

  it('represents M3 with a 1M context window, image/video input and adaptive/disabled thinking', () => {
    const m3 = getMinimaxModel('MiniMax-M3');
    expect(m3).toBeDefined();
    expect(m3?.contextWindow).toBe(1_000_000);
    expect(m3?.inputModalities).toEqual(['text', 'image', 'video']);
    expect(m3?.thinking).toEqual(['adaptive', 'disabled']);
  });

  it('represents M2.7 as a 204K text-only always-on model', () => {
    const m27 = getMinimaxModel('MiniMax-M2.7');
    expect(m27).toBeDefined();
    expect(m27?.contextWindow).toBe(204_800);
    expect(m27?.inputModalities).toEqual(['text']);
    expect(m27?.thinking).toEqual(['always_on']);
  });

  it('does not clone the M2.7 profile onto M3', () => {
    const m3 = getMinimaxModel('MiniMax-M3');
    const m27 = getMinimaxModel('MiniMax-M2.7');
    expect(m3?.contextWindow).not.toBe(m27?.contextWindow);
    expect(m3?.inputModalities).not.toEqual(m27?.inputModalities);
  });

  it('returns undefined for unknown models', () => {
    expect(getMinimaxModel('nope')).toBeUndefined();
  });

  it('exposes exactly the catalogued models', () => {
    expect(MINIMAX_MODELS).toHaveLength(2);
  });
});

describe('minimax catalog endpoints', () => {
  it('exposes the global and China regions', () => {
    expect(MINIMAX_ENDPOINTS.map((e) => e.region)).toEqual(['global_en', 'cn_zh']);
  });

  it('exposes both protocol base URLs for the global region', () => {
    expect(minimaxBaseUrl('global_en', 'openai')).toBe('https://api.minimax.io/v1');
    expect(minimaxBaseUrl('global_en', 'anthropic')).toBe('https://api.minimax.io/anthropic');
  });

  it('exposes both protocol base URLs for the China region', () => {
    expect(minimaxBaseUrl('cn_zh', 'openai')).toBe('https://api.minimaxi.com/v1');
    expect(minimaxBaseUrl('cn_zh', 'anthropic')).toBe('https://api.minimaxi.com/anthropic');
  });

  it('defaults to the global region', () => {
    expect(DEFAULT_MINIMAX_REGION).toBe('global_en');
  });

  it('builds the chat completions URL from the region base URL', () => {
    expect(minimaxChatCompletionsUrl('global_en')).toBe(
      'https://api.minimax.io/v1/chat/completions',
    );
    expect(minimaxChatCompletionsUrl('cn_zh')).toBe('https://api.minimaxi.com/v1/chat/completions');
  });

  it('falls back to the global endpoint for the default region', () => {
    expect(getMinimaxEndpoint(DEFAULT_MINIMAX_REGION).region).toBe('global_en');
  });
});
