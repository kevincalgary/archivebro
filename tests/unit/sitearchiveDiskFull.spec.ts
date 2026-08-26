import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SiteArchiveBuilder } from '../../src/main/sitearchive/archiveWriter';
import { DiskFullError } from '../../src/main/capture/diskSpace';

// Exercises the real SiteArchiveBuilder write paths (addAsset/addPage/
// addForumPost all funnel through writeWithEnospcRetry -- see
// archiveWriter.ts) against a real staging directory, with fs.writeFile
// itself faked to simulate a disk that's out of space. This is what
// diskSpace.spec.ts's unit-level writeWithEnospcRetry tests can't cover on
// their own: that the retry wrapper is actually wired into the methods a
// live capture calls, not just correct in isolation.

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-enospc-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

function enospcError(): NodeJS.ErrnoException {
  const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
  err.code = 'ENOSPC';
  return err;
}

describe('SiteArchiveBuilder ENOSPC handling', () => {
  it('retries a write that hits ENOSPC once and succeeds once space frees up', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    const realWriteFile = fs.writeFile.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      calls += 1;
      if (calls === 1) throw enospcError();
      return realWriteFile(...args);
    });

    const asset = await builder.addAsset(Buffer.from('logo-bytes'), 'image/png', 'https://example.com/logo.png');

    expect(calls).toBe(2); // one failed attempt, one that actually wrote the bytes
    const written = await fs.readFile(path.join(builder.stagingPath!, asset.path));
    expect(written.toString()).toBe('logo-bytes');

    await builder.cleanup();
  });

  it('retries addPage/addForumPost writes the same way, not just addAsset', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    let failuresLeft = 1;
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw enospcError();
      }
      return realWriteFile(...args);
    });

    const page = await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      title: 'Home',
      depth: 0,
      html: '<html></html>',
      screenshot: null,
      text: 'Home',
      redirectedFrom: [],
    });
    expect(await fs.readFile(path.join(builder.stagingPath!, page.htmlPath), 'utf8')).toBe('<html></html>');

    await builder.cleanup();
  });

  it('surfaces a distinct DiskFullError once retries are exhausted, instead of the raw ENOSPC error', async () => {
    vi.useFakeTimers();
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    vi.spyOn(fs, 'writeFile').mockRejectedValue(enospcError());

    const pending = builder
      .addAsset(Buffer.from('logo-bytes'), 'image/png', 'https://example.com/logo.png')
      .then(
        () => ({ status: 'resolved' as const }),
        (err: unknown) => ({ status: 'rejected' as const, err }),
      );

    // Advance past the full backoff schedule (ENOSPC_RETRY_DELAYS_MS) without
    // actually waiting the real 12+ seconds it sums to.
    await vi.advanceTimersByTimeAsync(60_000);

    const outcome = await pending;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.err).toBeInstanceOf(DiskFullError);
    }

    vi.useRealTimers();
    await builder.cleanup();
  });

  it('does not retry a write that fails for a reason other than ENOSPC', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    const permissionError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    permissionError.code = 'EACCES';
    const spy = vi.spyOn(fs, 'writeFile').mockRejectedValue(permissionError);

    await expect(
      builder.addAsset(Buffer.from('logo-bytes'), 'image/png', 'https://example.com/logo.png'),
    ).rejects.toBe(permissionError);
    expect(spy).toHaveBeenCalledTimes(1); // no retry for a non-ENOSPC failure

    await builder.cleanup();
  });
});
