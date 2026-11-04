import { describe, expect, it } from 'vitest';
import { hoursUntilTomorrowMorning } from './date';

describe('hoursUntilTomorrowMorning', () => {
  it('counts to 9:00 on the next calendar day', () => {
    const now = new Date(2026, 9, 21, 17, 30);
    const until = now.getTime() + hoursUntilTomorrowMorning(now) * 3_600_000;
    expect(until).toBeCloseTo(new Date(2026, 9, 22, 9, 0).getTime(), -1);
  });

  it('still means the next day shortly after midnight', () => {
    const now = new Date(2026, 9, 21, 0, 30);
    expect(hoursUntilTomorrowMorning(now)).toBeCloseTo(32.5);
  });

  it('rolls over month ends', () => {
    const now = new Date(2026, 9, 31, 22, 0);
    const until = now.getTime() + hoursUntilTomorrowMorning(now) * 3_600_000;
    expect(until).toBeCloseTo(new Date(2026, 10, 1, 9, 0).getTime(), -1);
  });
});
