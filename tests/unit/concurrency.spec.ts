import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, withDeadline, TIMED_OUT } from '../../src/main/util/concurrency';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const { results, abandoned } = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
      await tick(ms);
      return `item-${i}`;
    });
    expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
    expect(abandoned).toBe(0);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('abandons the remaining work once the budget is spent', async () => {
    // The forum photo-thread case: a page with far more resources than its
    // time budget allows. Without this, one page holds the crawl open.
    let called = 0;
    let spent = false;
    const items = Array.from({ length: 100 }, (_, i) => i);

    const { results, abandoned } = await mapWithConcurrency(
      items,
      4,
      async (i) => {
        called += 1;
        if (called >= 10) spent = true;
        await tick(1);
        return i;
      },
      () => spent,
    );

    expect(called).toBeLessThan(100);
    expect(abandoned).toBeGreaterThan(0);
    expect(called + abandoned).toBe(100);
    // Abandoned slots read as null, indistinguishable from a failure, so
    // callers cannot mistake them for successfully fetched resources.
    expect(results.filter((r) => r === null).length).toBe(abandoned);
  });

  it('does no work at all when the budget is already gone', async () => {
    let called = 0;
    const { abandoned } = await mapWithConcurrency([1, 2, 3], 2, async () => { called += 1; return 1; }, () => true);
    expect(called).toBe(0);
    expect(abandoned).toBe(3);
  });

  it('handles an empty list', async () => {
    const { results, abandoned } = await mapWithConcurrency([], 4, async () => 1);
    expect(results).toEqual([]);
    expect(abandoned).toBe(0);
  });

  it('names exactly which indices were abandoned, not just how many', async () => {
    // A resource abandoned for budget reasons must be tellable apart from
    // one that was actually attempted and failed -- otherwise every
    // budget casualty gets mislabelled as a genuine fetch failure.
    let called = 0;
    let spent = false;
    const items = [0, 1, 2, 3, 4, 5];

    const { abandonedIndices } = await mapWithConcurrency(
      items,
      1,
      async (i) => {
        called += 1;
        if (i === 2) spent = true;
        return i;
      },
      () => spent,
    );

    expect(called).toBe(3); // 0, 1, 2 ran before the budget was marked spent
    expect([...abandonedIndices].sort()).toEqual([3, 4, 5]);
  });
});

describe('withDeadline', () => {
  it('resolves with the value when the promise settles before the deadline', async () => {
    const result = await withDeadline(Promise.resolve('done'), Date.now() + 1000);
    expect(result).toBe('done');
  });

  it('resolves to TIMED_OUT when the deadline passes first', async () => {
    const neverSettles = new Promise<string>(() => {});
    const result = await withDeadline(neverSettles, Date.now() + 10);
    expect(result).toBe(TIMED_OUT);
  });

  it('resolves to TIMED_OUT almost immediately when the deadline has already passed', async () => {
    const neverSettles = new Promise<string>(() => {});
    const started = Date.now();
    const result = await withDeadline(neverSettles, Date.now() - 1000);
    expect(result).toBe(TIMED_OUT);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('propagates a rejection that happens before the deadline', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), Date.now() + 1000)).rejects.toThrow('boom');
  });
});
