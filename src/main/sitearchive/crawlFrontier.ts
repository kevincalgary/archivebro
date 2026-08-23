/**
 * The crawl queue, rotated across the pages that discovered each link.
 *
 * A plain FIFO makes the crawl strictly breadth-first, which sounds
 * even-handed and isn't: one page with a lot of links owns the entire
 * budget. On a forum this is fatal. rangerovers.net's front page alone
 * yields 86 in-scope links, and the threads sit one level below those, so
 * a 50-page capture spent every slot on section and navigation pages and
 * archived zero threads -- the whole point of capturing a forum.
 *
 * Bucketing by the discovering page and taking one item per bucket per
 * turn fixes that with no site-specific knowledge: as soon as a section
 * page is captured, the threads it discovered interleave with the sections
 * still queued. Order within a bucket stays FIFO, so one page's links are
 * still followed in document order.
 *
 * Kept free of Electron imports so the ordering can be tested as pure
 * logic rather than only through a full app run.
 */

export interface FrontierItem {
  url: string;
  depth: number;
  discoveredOn: string | null;
}

/** Compact the rotation ring once the dead prefix is worth reclaiming. */
const COMPACT_AFTER = 1_000;

export class CrawlFrontier {
  private buckets = new Map<string, FrontierItem[]>();
  /**
   * Keys of the non-empty buckets, in rotation order.
   *
   * The invariant that makes this cheap: `rotation[head..]` holds exactly
   * the keys of the non-empty buckets, each once. A drained bucket is
   * dropped instead of being left in the ring -- an earlier version kept
   * every key forever and re-scanned the dead ones on each turn, which is
   * quadratic. A fanout-of-one site (ordinary "next page" pagination) made
   * that 450 million scan steps over a 30,000-page crawl.
   */
  private rotation: string[] = [];
  private head = 0;
  private count = 0;

  get size(): number {
    return this.count;
  }

  push(item: FrontierItem): void {
    const key = item.discoveredOn ?? '';
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
      this.rotation.push(key);
    }
    bucket.push(item);
    this.count += 1;
  }

  shift(): FrontierItem | undefined {
    if (this.count === 0) return undefined;

    const key = this.rotation[this.head]!;
    this.head += 1;
    const bucket = this.buckets.get(key)!;
    const item = bucket.shift()!;
    this.count -= 1;

    if (bucket.length > 0) {
      this.rotation.push(key); // back of the queue for its next turn
    } else {
      this.buckets.delete(key);
    }

    if (this.head >= COMPACT_AFTER && this.head * 2 > this.rotation.length) {
      this.rotation = this.rotation.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  /** Remaining items, for reporting what a truncated crawl left behind. */
  pending(): FrontierItem[] {
    const out: FrontierItem[] = [];
    for (let i = this.head; i < this.rotation.length; i += 1) {
      const bucket = this.buckets.get(this.rotation[i]!);
      if (bucket) out.push(...bucket);
    }
    return out;
  }
}
