/**
 * Run `fn` over `items` with at most `limit` in flight, preserving result
 * order.
 *
 * `stop` is the page's time budget. When it starts returning true the
 * remaining items are abandoned rather than started: nothing bounded the
 * capture phases collectively before, so one pathological page (a forum
 * photo thread with 116 images across 27 dead hosts) could hold an entire
 * crawl open indefinitely.
 *
 * Abandoned items come back as `null`, the same as a failed one. `abandoned`
 * is the count, for a summary warning; `abandonedIndices` names exactly
 * which ones so the caller can tell "budget ran out" apart from "the fetch
 * itself failed" -- the two are otherwise indistinguishable null results,
 * and conflating them mislabels every budget casualty as a genuine fetch
 * failure.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stop?: () => boolean,
): Promise<{ results: Array<R | null>; abandoned: number; abandonedIndices: ReadonlySet<number> }> {
  const results = new Array<R | null>(items.length).fill(null);
  const abandonedIndices = new Set<number>();
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      if (stop?.()) {
        abandonedIndices.add(index);
        continue;
      }
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return { results, abandoned: abandonedIndices.size, abandonedIndices };
}

/** Returned by {@link withDeadline} when the deadline wins the race. */
export const TIMED_OUT = Symbol('timed-out');

/**
 * Race `promise` against a deadline (an absolute `Date.now()`-scale
 * timestamp, matching how the page capture budget is already tracked).
 *
 * This does not cancel `promise` -- `executeJavaScript` and CDP calls have
 * no cancellation hook -- it only stops *waiting* on it past the deadline,
 * the same trade-off `mapWithConcurrency` already makes for resource
 * fetches. Without this, a capture phase with no timeout of its own (a
 * stuck in-page script, a CDP screenshot call that never resolves) can
 * still hang a page -- and therefore the whole crawl -- indefinitely, even
 * though a page time budget exists.
 */
export function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | typeof TIMED_OUT> {
  const remaining = Math.max(0, deadlineMs - Date.now());
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
