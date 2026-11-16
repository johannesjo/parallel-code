/**
 * Runs at most `max` jobs at once; the rest wait their turn in order. A
 * finishing job hands its slot straight to the next waiter, so a caller
 * arriving in between can't push the count over `max`.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(job: () => Promise<T>): Promise<T> {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
