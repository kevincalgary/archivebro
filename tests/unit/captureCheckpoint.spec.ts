import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CaptureJournal,
  CHECKPOINT_JOURNAL_FILE,
  CHECKPOINT_META_FILE,
  readCheckpointMeta,
  replayCheckpoint,
} from '../../src/main/sitearchive/captureJournal';
import {
  SiteArchiveBuilder,
  finalizeRecoveredCapture,
  listRecoverableCaptures,
  sweepSiteArchiveStaging,
} from '../../src/main/sitearchive/archiveWriter';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';
import { DEFAULT_SITE_SCOPE } from '../../src/shared/sitearchiveTypes';

/**
 * The failure these guard against: a 151-minute, 810-page crawl that died
 * at the end and produced nothing at all, because the archive is only
 * written once the whole crawl completes. The staged bytes survived; the
 * in-memory bookkeeping did not.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function metaFor(archiveId: string, outputPath: string) {
  return {
    archiveId,
    appVersion: '0.1.0',
    startUrl: 'https://example.com/',
    outputPath,
    scope: DEFAULT_SITE_SCOPE,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Run a partial capture and abandon it exactly the way a killed process
 * would: no finalize, no cleanup, journal left as-is on disk.
 */
async function crawlThenDie(pages: number): Promise<{ stagingDir: string; archiveId: string; outputPath: string }> {
  const archiveId = crypto.randomUUID();
  const outputPath = path.join(tmp, 'out', 'example.sitearchive');
  const builder = new SiteArchiveBuilder(archiveId, '0.1.0');
  await builder.init(tmp);
  const stagingDir = builder.stagingPath!;

  const journal = await CaptureJournal.create(stagingDir, metaFor(archiveId, outputPath));
  builder.setJournal(journal);

  // A shared asset, to exercise the dedupe/sourceUrls journal path.
  const logo = Buffer.from('shared-logo-bytes');

  for (let i = 0; i < pages; i += 1) {
    const url = `https://example.com/page-${i}`;
    await journal.append({ t: 'enq', url, norm: url, depth: 1, on: null });
    await journal.append({ t: 'deq', norm: url });
    await builder.addAsset(logo, 'image/png', `${url}/logo.png`);
    await builder.addPage({
      pageId: `page-${i}`,
      originalUrl: url,
      finalUrl: url,
      normalizedUrl: url,
      title: `Page ${i}`,
      depth: 1,
      html: `<html><body>page ${i}</body></html>`,
      screenshot: Buffer.from(`shot-${i}`),
      text: `page ${i} text`,
      redirectedFrom: [],
    });
    await journal.append({
      t: 'stat',
      bytesDownloaded: (i + 1) * 1000,
      warnings: 0,
      total: builder.totalBytes,
      title: 'Example',
    });
  }

  // Two pages discovered but never reached -- the pending queue.
  for (const url of ['https://example.com/never-a', 'https://example.com/never-b']) {
    await journal.append({ t: 'enq', url, norm: url, depth: 2, on: 'https://example.com/page-0' });
  }

  // Killed: the handle simply goes away. No close(), no finalize, no cleanup.
  await journal.close();
  return { stagingDir, archiveId, outputPath };
}

describe('capture checkpoint journal', () => {
  it('replays a killed capture back into full crawl state', async () => {
    const { stagingDir, archiveId } = await crawlThenDie(5);

    const replayed = await replayCheckpoint(stagingDir);
    expect(replayed).not.toBeNull();
    expect(replayed!.meta.archiveId).toBe(archiveId);
    expect(replayed!.pages).toHaveLength(5);
    expect(replayed!.pagesCompleted).toBe(5);
    expect(replayed!.pagesDiscovered).toBe(7);
    expect(replayed!.bytesDownloaded).toBe(5000);
    expect(replayed!.siteTitle).toBe('Example');
    expect(replayed!.malformedLines).toBe(0);

    // The two never-captured URLs are still queued, in discovery order.
    expect(replayed!.queue.map((q) => q.url)).toEqual([
      'https://example.com/never-a',
      'https://example.com/never-b',
    ]);
    // ...and everything seen is remembered, so a resume can't re-crawl it.
    expect(replayed!.queuedOrDone.size).toBe(7);
    expect(replayed!.queuedOrDone.has('https://example.com/page-0')).toBe(true);
  });

  it('deduplicates a shared asset and keeps every source URL', async () => {
    const { stagingDir } = await crawlThenDie(4);
    const replayed = await replayCheckpoint(stagingDir);

    // One logo, stored once, referenced from four pages.
    expect(replayed!.assets.size).toBe(1);
    const asset = [...replayed!.assets.values()][0]!;
    expect(asset.sourceUrls).toHaveLength(4);
  });

  it('tolerates the truncated final line a killed process leaves behind', async () => {
    const { stagingDir } = await crawlThenDie(5);
    const journalPath = path.join(stagingDir, CHECKPOINT_JOURNAL_FILE);

    // Cut the file mid-record, exactly as a kill during append would.
    const raw = await fs.readFile(journalPath, 'utf8');
    await fs.writeFile(journalPath, `${raw}{"t":"page","e":{"pageId":"half-writ`);

    const replayed = await replayCheckpoint(stagingDir);
    expect(replayed).not.toBeNull();
    expect(replayed!.malformedLines).toBe(1);
    // Everything before the torn line survives intact.
    expect(replayed!.pages).toHaveLength(5);
    expect(replayed!.queue).toHaveLength(2);
  });

  it('reports no checkpoint for a staging tree that never had one', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    expect(await readCheckpointMeta(builder.stagingPath!)).toBeNull();
    expect(await replayCheckpoint(builder.stagingPath!)).toBeNull();
  });

  it('refuses a checkpoint written by an incompatible version', async () => {
    const { stagingDir } = await crawlThenDie(2);
    const metaPath = path.join(stagingDir, CHECKPOINT_META_FILE);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    meta.checkpointVersion = 999;
    await fs.writeFile(metaPath, JSON.stringify(meta));

    expect(await replayCheckpoint(stagingDir)).toBeNull();
  });

  it('surfaces the page that was in flight when the process died, instead of losing it', async () => {
    // Everything crawlThenDie() produces resolves cleanly (a 'page' or
    // 'failure' record always follows its 'deq'). This reproduces the
    // actual crash shape: dequeued for capture, then nothing -- no page,
    // no failure, because the process died mid-capture.
    const archiveId = crypto.randomUUID();
    const outputPath = path.join(tmp, 'out', 'example.sitearchive');
    const builder = new SiteArchiveBuilder(archiveId, '0.1.0');
    await builder.init(tmp);
    const stagingDir = builder.stagingPath!;
    const journal = await CaptureJournal.create(stagingDir, metaFor(archiveId, outputPath));

    const inFlightUrl = 'https://example.com/in-flight';
    await journal.append({ t: 'enq', url: inFlightUrl, norm: inFlightUrl, depth: 1, on: null });
    await journal.append({ t: 'deq', norm: inFlightUrl });
    // Killed here: no 'page', no 'failure' -- the process died while
    // capturing this page.
    await journal.close();

    const replayed = await replayCheckpoint(stagingDir);
    expect(replayed).not.toBeNull();

    // Not silently retried -- it's the page most likely to have caused
    // the death.
    expect(replayed!.queue).toHaveLength(0);
    // ...but it does not simply vanish: it shows up as an interrupted
    // failure, so a partial archive or a resume both account for it.
    expect(replayed!.failures).toHaveLength(1);
    expect(replayed!.failures[0]).toMatchObject({ url: inFlightUrl, kind: 'interrupted' });
  });
});

describe('recovering an interrupted capture', () => {
  it('produces a valid, readable archive from what the crawl managed to capture', async () => {
    const { stagingDir, outputPath } = await crawlThenDie(5);

    const recovered = await finalizeRecoveredCapture(stagingDir, '0.1.0');
    expect(recovered).not.toBeNull();
    expect(recovered!.pageCount).toBe(5);
    expect(recovered!.archivePath).toBe(outputPath);

    // The real test: the salvaged file opens and verifies like any other
    // archive -- checksums, manifest, and all.
    const opened = await openSiteArchive(outputPath);
    try {
      expect(opened.manifest.pages).toHaveLength(5);
      expect(opened.manifest.assets).toHaveLength(1);
      // It must not pretend to be complete.
      expect(opened.manifest.failures.some((f) => f.message.includes('interrupted'))).toBe(true);
    } finally {
      await opened.close?.();
    }
  });

  it('never ships the recovery journal inside the archive', async () => {
    // The journal records the output path and full URLs; a .sitearchive is
    // a file people hand to other people.
    const { stagingDir, outputPath } = await crawlThenDie(3);
    await finalizeRecoveredCapture(stagingDir, '0.1.0');

    const bytes = await fs.readFile(outputPath);
    expect(bytes.includes(Buffer.from(CHECKPOINT_JOURNAL_FILE))).toBe(false);
    expect(bytes.includes(Buffer.from(CHECKPOINT_META_FILE))).toBe(false);
  });

  it('cleans up the staging tree once the archive is safely written', async () => {
    const { stagingDir } = await crawlThenDie(3);
    await finalizeRecoveredCapture(stagingDir, '0.1.0');

    await expect(fs.stat(stagingDir)).rejects.toThrow();
  });

  it('does not list a staging tree whose capture process is still running', async () => {
    // Simulates a capture actively running right now -- possibly in
    // another app instance sharing this OS temp directory -- rather than
    // one that died. The lock file names this test's own (very much
    // alive) process, exactly like CaptureJournal.create leaves behind
    // while it's still open.
    const archiveId = crypto.randomUUID();
    const outputPath = path.join(tmp, 'out', 'live.sitearchive');
    const builder = new SiteArchiveBuilder(archiveId, '0.1.0');
    await builder.init(tmp);
    const stagingDir = builder.stagingPath!;
    const journal = await CaptureJournal.create(stagingDir, metaFor(archiveId, outputPath));
    await journal.append({ t: 'enq', url: 'https://example.com/', norm: 'https://example.com/', depth: 0, on: null });
    // Deliberately left open -- closing it would remove the lock.

    const recoverable = await listRecoverableCaptures(tmp);
    expect(recoverable.map((r) => r.meta.archiveId)).not.toContain(archiveId);

    await journal.close();
    // Once closed (the lock removed, exactly like an ordinary
    // finish/fail/cancel), it becomes visible immediately -- no arbitrary
    // wait, unlike a pure mtime-based staleness check would require.
    const afterClose = await listRecoverableCaptures(tmp);
    expect(afterClose.map((r) => r.meta.archiveId)).toContain(archiveId);
  });

  it('lists interrupted captures newest-first with their size', async () => {
    const first = await crawlThenDie(2);
    const second = await crawlThenDie(3);
    // Make the ordering unambiguous regardless of filesystem timestamp
    // granularity.
    const older = new Date(Date.now() - 60_000);
    await fs.utimes(first.stagingDir, older, older);
    for (const sub of ['pages', 'assets', 'screenshots', 'responses']) {
      await fs.utimes(path.join(first.stagingDir, sub), older, older);
    }

    const recoverable = await listRecoverableCaptures(tmp);

    expect(recoverable.map((r) => r.meta.archiveId)).toEqual([second.archiveId, first.archiveId]);
    expect(recoverable[0]!.bytesOnDisk).toBeGreaterThan(0);
  });
});

describe('the staging sweep and recoverable work', () => {
  const HOUR = 60 * 60 * 1000;

  /** Age every entry, including the checkpoint files -- liveness is the
   *  newest write anywhere in the tree, not just the subdirectories. */
  async function age(dir: string, ms: number): Promise<void> {
    const when = new Date(Date.now() - ms);
    for (const entry of await fs.readdir(dir)) {
      await fs.utimes(path.join(dir, entry), when, when).catch(() => undefined);
    }
    await fs.utimes(dir, when, when);
  }

  it('does not delete an interrupted capture that is still recoverable', async () => {
    // The leaked-staging fix reclaims anything idle for an hour. It must
    // not reclaim work the user can still finish.
    const { stagingDir } = await crawlThenDie(3);
    await age(stagingDir, 6 * HOUR);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(result.removed).toEqual([]);
    expect((await fs.stat(stagingDir)).isDirectory()).toBe(true);
    expect(await listRecoverableCaptures(tmp)).toHaveLength(1);
  });

  it('still deletes an abandoned tree with no checkpoint', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);
    await age(builder.stagingPath!, 6 * HOUR);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(result.removed).toHaveLength(1);
    await expect(fs.stat(builder.stagingPath!)).rejects.toThrow();
  });

  it('eventually reclaims a recoverable capture nobody came back for', async () => {
    const { stagingDir } = await crawlThenDie(2);
    await age(stagingDir, 30 * 24 * HOUR);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(result.removed).toHaveLength(1);
    await expect(fs.stat(stagingDir)).rejects.toThrow();
  });
});
