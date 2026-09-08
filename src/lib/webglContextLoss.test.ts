import { describe, expect, it } from 'vitest';
import {
  initialWebglLossState,
  recordWebglContextLoss,
  recordSharedWebglContextLoss,
  resetSharedWebglLossStateForTest,
  WEBGL_LOSS_RESET_MS,
  WEBGL_LOSS_WAVE_MS,
  WEBGL_MAX_LOSS_WAVES,
} from './webglContextLoss';

const T0 = 1_000_000;

describe('recordWebglContextLoss', () => {
  it('retries after a first loss', () => {
    const { retry } = recordWebglContextLoss(initialWebglLossState(), T0);
    expect(retry).toBe(true);
  });

  it('counts a simultaneous burst (GPU crash hitting every pane) as one wave', () => {
    let state = initialWebglLossState();
    let retry = false;
    // 20 panes lose their context within the same wave span.
    for (let i = 0; i < 20; i++) {
      ({ state, retry } = recordWebglContextLoss(state, T0 + i * 40));
      expect(retry).toBe(true);
    }
    expect(state.waves).toBe(1);
  });

  it('stops retrying when an eviction rotation produces repeated waves', () => {
    // Panes over the context cap: each reattach evicts another pane ~5s later.
    let state = initialWebglLossState();
    let retry = true;
    for (let i = 0; i < WEBGL_MAX_LOSS_WAVES; i++) {
      ({ state, retry } = recordWebglContextLoss(state, T0 + i * 5_000));
    }
    expect(retry).toBe(false);
  });

  it('brakes a drip of losses arriving just under the wave span apart', () => {
    // Desynchronized eviction chains can land losses <1s apart indefinitely.
    // Anchoring the wave at its start bounds this: the brake must trip.
    let state = initialWebglLossState();
    let retry = true;
    let i = 0;
    for (; i < 100 && retry; i++) {
      ({ state, retry } = recordWebglContextLoss(state, T0 + i * (WEBGL_LOSS_WAVE_MS - 100)));
    }
    expect(retry).toBe(false);
    // Trips once the third wave starts — a handful of losses, not dozens.
    expect(i).toBeLessThanOrEqual(6);
  });

  it('always retries isolated waves, e.g. one per sleep/wake cycle', () => {
    let state = initialWebglLossState();
    let retry = false;
    // Far more cycles than the wave budget, spaced beyond the reset window.
    for (let i = 0; i < WEBGL_MAX_LOSS_WAVES * 3; i++) {
      ({ state, retry } = recordWebglContextLoss(state, T0 + i * (WEBGL_LOSS_RESET_MS + 1)));
      expect(retry).toBe(true);
    }
  });

  it('resets the window after a quiet period', () => {
    let state = initialWebglLossState();
    // Two waves — one short of giving up.
    ({ state } = recordWebglContextLoss(state, T0));
    ({ state } = recordWebglContextLoss(state, T0 + WEBGL_LOSS_WAVE_MS + 1));
    // A loss after a quiet period starts a fresh window instead of giving up.
    const late = recordWebglContextLoss(state, T0 + 2 * WEBGL_LOSS_RESET_MS);
    expect(late.retry).toBe(true);
    expect(late.state.waves).toBe(1);
  });

  it('treats a backwards clock step as isolated, not rapid', () => {
    let state = initialWebglLossState();
    ({ state } = recordWebglContextLoss(state, T0));
    ({ state } = recordWebglContextLoss(state, T0 + WEBGL_LOSS_WAVE_MS + 1));
    // Wake-from-sleep NTP correction stamps the next loss before the previous one.
    const stepped = recordWebglContextLoss(state, T0 - 300_000);
    expect(stepped.retry).toBe(true);
    expect(stepped.state.waves).toBe(1);
  });
});

describe('recordSharedWebglContextLoss', () => {
  it('applies one window across callers (panes)', () => {
    resetSharedWebglLossStateForTest();
    // Distinct panes losing their contexts ~5s apart share the same brake.
    expect(recordSharedWebglContextLoss(T0)).toBe(true);
    expect(recordSharedWebglContextLoss(T0 + 5_000)).toBe(true);
    expect(recordSharedWebglContextLoss(T0 + 10_000)).toBe(false);
    resetSharedWebglLossStateForTest();
  });
});
