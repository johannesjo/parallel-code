/** Task transitions that get a chime. Mirrors the desktop notification types. */
export type ChimeType = 'ready' | 'needs_input' | 'error';

/** One synthesized note: frequency in Hz and its start offset in seconds. */
export interface ChimeNote {
  freq: number;
  at: number;
}

const NOTE_MS = 0.16;
const GAIN = 0.05;
/** Several tasks flipping in one poll tick should sound like one event. */
export const CHIME_THROTTLE_MS = 250;

/** Short synthesized motifs; a rising fifth reads as "done", a single tone as a
 *  question, and a low pair as "something broke". */
export function chimeNotesFor(type: ChimeType): ChimeNote[] {
  switch (type) {
    case 'ready':
      return [
        { freq: 659.25, at: 0 },
        { freq: 987.77, at: 0.12 },
      ];
    case 'needs_input':
      return [{ freq: 783.99, at: 0 }];
    case 'error':
      return [
        { freq: 311.13, at: 0 },
        { freq: 261.63, at: 0.14 },
      ];
  }
}

let sharedContext: AudioContext | undefined;
let lastChimeAt = -Infinity;

function getContext(): AudioContext | undefined {
  if (typeof AudioContext === 'undefined') return undefined;
  // One lazily created context: browsers cap the number of live contexts and
  // creating one per chime leaks them.
  try {
    sharedContext ??= new AudioContext();
  } catch {
    // Headless renderers and exhausted context caps throw; a silent cue beats
    // an exception inside the store effect that asked for it.
    return undefined;
  }
  return sharedContext;
}

function scheduleNote(ctx: AudioContext, note: ChimeNote, start: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = note.freq;
  const t0 = start + note.at;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(GAIN, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + NOTE_MS);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + NOTE_MS + 0.02);
}

/** Plays the chime for a task transition. Silent when WebAudio is unavailable
 *  or another chime started within the throttle window. Returns whether it played. */
export function playCompletionChime(type: ChimeType, now = Date.now()): boolean {
  if (now - lastChimeAt < CHIME_THROTTLE_MS) return false;
  const ctx = getContext();
  if (!ctx) return false;
  lastChimeAt = now;
  // Resume can reject when the OS denies audio; there is nothing to do about it.
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
  for (const note of chimeNotesFor(type)) scheduleNote(ctx, note, ctx.currentTime);
  return true;
}

/** Test hook: forget the throttle window and the shared context. */
export function resetCompletionChimeForTests(): void {
  sharedContext = undefined;
  lastChimeAt = -Infinity;
}
