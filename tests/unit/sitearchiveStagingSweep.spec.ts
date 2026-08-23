import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepSiteArchiveStaging } from '../../src/main/sitearchive/archiveWriter';

/**
 * A capture killed mid-crawl never reaches cleanup(), so its staging tree
 * -- gigabytes, for a large site -- stays in the OS temp directory
 * forever. Six such directories totalling 3.8 GB were found left behind by
 * real runs.
 */

const HOUR = 60 * 60 * 1000;

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Build a staging tree shaped like a real one, aged `ageMs` in the past. */
async function makeStaging(name: string, ageMs: number, bytes = 1024): Promise<string> {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', 'a.png'), Buffer.alloc(bytes));

  const when = new Date(Date.now() - ageMs);
  for (const p of [path.join(dir, 'assets'), path.join(dir, 'pages'), dir]) {
    await fs.utimes(p, when, when);
  }
  return dir;
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

describe('sweepSiteArchiveStaging', () => {
  it('removes an abandoned staging tree and reports what it freed', async () => {
    const dir = await makeStaging('sitearchive-staging-dead', 3 * HOUR, 4096);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(await exists(dir)).toBe(false);
    expect(result.removed).toEqual(['sitearchive-staging-dead']);
    expect(result.bytesFreed).toBeGreaterThanOrEqual(4096);
  });

  it('leaves a staging tree that a running capture is still writing to', async () => {
    // The e2e suite launches the real app while the user may have their own
    // instance open, and app.getPath('temp') is shared between them.
    const dir = await makeStaging('sitearchive-staging-live', 0);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(await exists(dir)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it('judges liveness by subdirectory writes, not the parent mtime', async () => {
    // A long crawl writes into assets/ and pages/, which never updates the
    // parent's mtime -- so a parent-only check would delete a live capture
    // out from under a crawl that had been running for over an hour.
    const dir = await makeStaging('sitearchive-staging-deep', 5 * HOUR);
    const now = new Date();
    await fs.writeFile(path.join(dir, 'assets', 'fresh.png'), Buffer.alloc(16));
    await fs.utimes(path.join(dir, 'assets'), now, now);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(await exists(dir)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it('touches nothing else in the temp directory', async () => {
    const staging = await makeStaging('sitearchive-staging-old', 3 * HOUR);
    const unrelatedDir = path.join(tmp, 'some-other-app-cache');
    const unrelatedFile = path.join(tmp, 'sitearchive-staging-lookalike.txt');
    await fs.mkdir(unrelatedDir, { recursive: true });
    await fs.writeFile(path.join(unrelatedDir, 'x'), 'x');
    await fs.writeFile(unrelatedFile, 'not a directory');
    const old = new Date(Date.now() - 5 * HOUR);
    await fs.utimes(unrelatedDir, old, old);
    await fs.utimes(unrelatedFile, old, old);

    const result = await sweepSiteArchiveStaging(tmp);

    expect(await exists(staging)).toBe(false);
    expect(await exists(unrelatedDir)).toBe(true);
    expect(await exists(unrelatedFile)).toBe(true);
    expect(result.removed).toEqual(['sitearchive-staging-old']);
  });

  it('is a no-op on a temp directory that does not exist', async () => {
    const result = await sweepSiteArchiveStaging(path.join(tmp, 'nope'));
    expect(result).toEqual({ removed: [], bytesFreed: 0 });
  });
});
