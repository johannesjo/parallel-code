/**
 * Which JavaScript functions a renderer spent its time in, from a V8 CPU
 * profile: self time per function, with its source location.
 */
import type { CDPSession } from '@playwright/test';

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
};
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

/** Starts sampling; the returned function stops it and resolves with the profile. */
export const startProfile = async (cdp: CDPSession): Promise<() => Promise<Profile>> => {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  return async () => (await cdp.send('Profiler.stop')).profile as unknown as Profile;
};

/** The functions with the most self time, in ms, keyed by name and location. */
export const summarizeProfile = (profile: Profile, top = 20): Record<string, number> => {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const frame = nodes.get(id)?.callFrame;
    if (!frame) return;
    const file = frame.url.split('/').pop() ?? '';
    const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
    totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  return Object.fromEntries(
    [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, us]) => [key, Math.round(us / 1000)]),
  );
};
