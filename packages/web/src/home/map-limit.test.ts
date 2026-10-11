import { describe, expect, it } from 'vitest';

import { mapLimit } from './map-limit';

describe('mapLimit', () => {
  it('keeps results in input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it('answers an empty list without work', async () => {
    expect(await mapLimit([], 4, () => Promise.reject(new Error('unused')))).toEqual([]);
  });
});
