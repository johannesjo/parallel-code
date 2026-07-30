/**
 * Catalog of the MiniMax models and regional API endpoints used by the inline
 * "Ask about Code" provider.
 *
 * Centralizing this metadata keeps the provider from being pinned to a single
 * model or a single endpoint: each model carries its own context window, input
 * modalities and thinking modes, and each region exposes both of its
 * supported protocol base URLs.
 */

/** Regions where the MiniMax platform is reachable. */
export type MinimaxRegion = 'global_en' | 'cn_zh';

/** Wire protocols each MiniMax endpoint speaks. */
export type MinimaxProtocol = 'openai' | 'anthropic';

/** Input modalities a MiniMax model can accept. */
export type MinimaxInputModality = 'text' | 'image' | 'video';

/** Thinking modes a MiniMax model supports. */
export type MinimaxThinkingMode = 'adaptive' | 'disabled' | 'always_on';

export interface MinimaxModel {
  /** Model identifier sent as the `model` field on the wire. */
  id: string;
  /** Maximum number of tokens the model accepts in a single request. */
  contextWindow: number;
  /** Input modalities the model understands. */
  inputModalities: MinimaxInputModality[];
  /** Thinking modes the model exposes. */
  thinking: MinimaxThinkingMode[];
}

export interface MinimaxEndpoint {
  region: MinimaxRegion;
  /** Base URL for the `openai` protocol; chat completions live under `${openaiBaseUrl}/chat/completions`. */
  openaiBaseUrl: string;
  /** Base URL for the `anthropic` protocol. */
  anthropicBaseUrl: string;
  /** Root of the platform documentation for this region. */
  docsRoot: string;
}

/**
 * Supported models, newest first. M3 carries a 1M-token context window and
 * accepts image and video input with adaptive or disabled thinking; M2.7 is
 * retained as a 204K-token text-only model with always-on thinking.
 */
export const MINIMAX_MODELS: MinimaxModel[] = [
  {
    id: 'MiniMax-M3',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image', 'video'],
    thinking: ['adaptive', 'disabled'],
  },
  {
    id: 'MiniMax-M2.7',
    contextWindow: 204_800,
    inputModalities: ['text'],
    thinking: ['always_on'],
  },
];

/** Regional endpoints and the protocol base URLs each one exposes. */
export const MINIMAX_ENDPOINTS: MinimaxEndpoint[] = [
  {
    region: 'global_en',
    openaiBaseUrl: 'https://api.minimax.io/v1',
    anthropicBaseUrl: 'https://api.minimax.io/anthropic',
    docsRoot: 'https://platform.minimax.io/docs',
  },
  {
    region: 'cn_zh',
    openaiBaseUrl: 'https://api.minimaxi.com/v1',
    anthropicBaseUrl: 'https://api.minimaxi.com/anthropic',
    docsRoot: 'https://platform.minimaxi.com/docs',
  },
];

/** Default model used by the inline code Q&A provider. */
export const DEFAULT_MINIMAX_MODEL_ID = 'MiniMax-M3';

/** Default region used by the inline code Q&A provider. */
export const DEFAULT_MINIMAX_REGION: MinimaxRegion = 'global_en';

/** Model ids in the catalog, newest first. */
export function minimaxModelIds(): string[] {
  return MINIMAX_MODELS.map((model) => model.id);
}

/** Looks up a model by id, or `undefined` when it is not in the catalog. */
export function getMinimaxModel(id: string): MinimaxModel | undefined {
  return MINIMAX_MODELS.find((model) => model.id === id);
}

/** Returns the endpoint for a region, falling back to the first (global) one. */
export function getMinimaxEndpoint(region: MinimaxRegion): MinimaxEndpoint {
  return MINIMAX_ENDPOINTS.find((endpoint) => endpoint.region === region) ?? MINIMAX_ENDPOINTS[0];
}

/** Returns the base URL a region exposes for the given protocol. */
export function minimaxBaseUrl(region: MinimaxRegion, protocol: MinimaxProtocol): string {
  const endpoint = getMinimaxEndpoint(region);
  return protocol === 'anthropic' ? endpoint.anthropicBaseUrl : endpoint.openaiBaseUrl;
}

/** Builds the chat completions URL for a region. */
export function minimaxChatCompletionsUrl(region: MinimaxRegion): string {
  return `${minimaxBaseUrl(region, 'openai')}/chat/completions`;
}
