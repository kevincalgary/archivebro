import { describe, it, expect } from 'vitest';
import { CrawlFrontier, type FrontierItem } from '../../src/main/sitearchive/crawlFrontier';

const item = (url: string, discoveredOn: string | null, depth = 1): FrontierItem => ({ url, depth, discoveredOn });

function drain(f: CrawlFrontier): string[] {
  const out: string[] = [];
  for (;;) {
    const next = f.shift();
    if (!next) return out;
    out.push(next.url);
  }
}

describe('CrawlFrontier', () => {
  it('preserves document order within one page links', () => {
    const f = new CrawlFrontier();
    for (const u of ['a', 'b', 'c']) f.push(item(u, 'page1'));
    expect(drain(f)).toEqual(['a', 'b', 'c']);
  });

  it('rotates between the pages that discovered each link', () => {
    const f = new CrawlFrontier();
    for (const u of ['a1', 'a2', 'a3']) f.push(item(u, 'A'));
    for (const u of ['b1', 'b2', 'b3']) f.push(item(u, 'B'));

    // Not A's three followed by B's three.
    expect(drain(f)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('tracks its size and empties completely', () => {
    const f = new CrawlFrontier();
    expect(f.size).toBe(0);
    expect(f.shift()).toBeUndefined();

    f.push(item('a', null));
    f.push(item('b', 'A'));
    expect(f.size).toBe(2);
    drain(f);
    expect(f.size).toBe(0);
    expect(f.shift()).toBeUndefined();
  });

  it('reports everything still pending', () => {
    const f = new CrawlFrontier();
    f.push(item('a1', 'A'));
    f.push(item('b1', 'B'));
    f.shift();
    expect(f.pending().map((i) => i.url).sort()).toEqual(['b1']);
  });

  it('does not let one link-dense page starve the others', () => {
    // The forum shape: an index offering far more links than the budget,
    // and a section page whose children are the content actually wanted.
    const f = new CrawlFrontier();
    for (let i = 0; i < 40; i += 1) f.push(item(`section-${i}`, 'index'));

    const budget = 12;
    const captured: string[] = [];
    for (let i = 0; i < budget; i += 1) {
      const next = f.shift();
      if (!next) break;
      captured.push(next.url);
      // Capturing a section discovers its threads.
      if (next.url.startsWith('section-')) {
        for (let t = 0; t < 5; t += 1) f.push(item(`${next.url}-thread-${t}`, next.url));
      }
    }

    // Breadth-first would spend all 12 slots on sections and reach no
    // thread at all -- which is the bug this exists to prevent.
    expect(captured.filter((u) => u.includes('thread')).length).toBeGreaterThan(0);
    expect(captured.filter((u) => !u.includes('thread')).length).toBeGreaterThan(0);
  });

  it('stays linear when every bucket drains immediately', () => {
    // Fanout-of-one, i.e. ordinary "next page" pagination. Leaving drained
    // buckets in the rotation made this quadratic: 450 million scan steps
    // over a 30,000-page crawl. It must not regress.
    const f = new CrawlFrontier();
    f.push(item('p0', null));

    const pages = 20_000;
    const started = Date.now();
    for (let i = 1; i <= pages; i += 1) {
      const next = f.shift();
      expect(next).toBeDefined();
      f.push(item(`p${i}`, next!.url));
    }
    // Generous: quadratic behaviour here took multiple seconds and grew
    // with the square of the page count.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(f.size).toBe(1);
  });
});
