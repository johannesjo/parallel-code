import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHIME_THROTTLE_MS,
  chimeNotesFor,
  playCompletionChime,
  resetCompletionChimeForTests,
} from './completion-chime';

function fakeAudioContext() {
  const oscillators: Array<{ start: ReturnType<typeof vi.fn> }> = [];
  const gainNode = () => ({
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn().mockReturnThis(),
  });
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    createGain = gainNode;
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn().mockReturnValue({ connect: vi.fn() }),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }
  }
  return { FakeContext, oscillators };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCompletionChimeForTests();
});

describe('chimeNotesFor', () => {
  it('rises for ready so the ear reads it as done', () => {
    const notes = chimeNotesFor('ready');
    expect(notes.length).toBeGreaterThan(1);
    expect(notes[1].freq).toBeGreaterThan(notes[0].freq);
    expect(notes[1].at).toBeGreaterThan(notes[0].at);
  });

  it('falls for error so it is distinguishable from ready', () => {
    const notes = chimeNotesFor('error');
    expect(notes[1].freq).toBeLessThan(notes[0].freq);
  });

  it('uses a single note for needs_input', () => {
    expect(chimeNotesFor('needs_input')).toHaveLength(1);
  });
});

describe('playCompletionChime', () => {
  it('schedules one oscillator per note', () => {
    const { FakeContext, oscillators } = fakeAudioContext();
    vi.stubGlobal('AudioContext', FakeContext);

    expect(playCompletionChime('ready', 1_000)).toBe(true);

    expect(oscillators).toHaveLength(chimeNotesFor('ready').length);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalledOnce();
  });

  it('collapses a burst into a single chime', () => {
    const { FakeContext, oscillators } = fakeAudioContext();
    vi.stubGlobal('AudioContext', FakeContext);

    playCompletionChime('ready', 1_000);
    expect(playCompletionChime('error', 1_000 + CHIME_THROTTLE_MS - 1)).toBe(false);
    expect(playCompletionChime('error', 1_000 + CHIME_THROTTLE_MS)).toBe(true);
    expect(oscillators).toHaveLength(4);
  });

  it('stays silent instead of throwing when audio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(playCompletionChime('ready')).toBe(false);

    vi.stubGlobal('AudioContext', function ThrowingContext() {
      throw new Error('too many contexts');
    });
    expect(() => playCompletionChime('ready')).not.toThrow();
  });
});
