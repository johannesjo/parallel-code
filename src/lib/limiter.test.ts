import { describe, expect, it } from 'vitest';
import { createLimiter } from './limiter';

describe('createLimiter', () => {
  it('frees the slot of a failed job and never runs more than the limit', async () => {
    const limit = createLimiter(1);
    let running = 0;
    let most = 0;
    const job = (fail: boolean) => async () => {
      running++;
      most = Math.max(most, running);
      await Promise.resolve();
      running--;
      if (fail) throw new Error('boom');
      return 'ok';
    };
    const first = limit(job(true));
    const second = limit(job(false));
    // Arrives while the first job's slot is being handed to the second.
    const late = first.catch(() => limit(job(false)));
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('ok');
    expect(await late).toBe('ok');
    expect(most).toBe(1);
  });
});
