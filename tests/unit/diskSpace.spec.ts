import { describe, it, expect, vi, beforeEach } from 'vitest';

const statfsMock = vi.fn();
const mkdirMock = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs', () => ({
  promises: {
    statfs: (...args: unknown[]) => statfsMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
  },
}));

const { getDiskSpace, hasSufficientDiskSpace, writeWithEnospcRetry, DiskFullError } = await import(
  '../../src/main/capture/diskSpace'
);

function enospcError(): NodeJS.ErrnoException {
  const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
  err.code = 'ENOSPC';
  return err;
}

beforeEach(() => {
  statfsMock.mockReset();
  mkdirMock.mockClear();
});

describe('getDiskSpace', () => {
  it('computes free/total bytes from statfs block counts', async () => {
    statfsMock.mockResolvedValue({ bavail: 1000, bsize: 4096, blocks: 5000 });
    const info = await getDiskSpace('/tmp/archives');
    expect(info).toEqual({ freeBytes: 1000 * 4096, totalBytes: 5000 * 4096 });
  });

  it('returns null instead of throwing when statfs is unavailable', async () => {
    statfsMock.mockRejectedValue(new Error('ENOSYS'));
    const info = await getDiskSpace('/tmp/archives');
    expect(info).toBeNull();
  });
});

describe('hasSufficientDiskSpace', () => {
  it('returns false when free space is below the safety margin', async () => {
    statfsMock.mockResolvedValue({ bavail: 10, bsize: 4096, blocks: 100000 }); // ~40KB free
    expect(await hasSufficientDiskSpace('/tmp/archives')).toBe(false);
  });

  it('returns true when there is plenty of free space', async () => {
    statfsMock.mockResolvedValue({ bavail: 10_000_000, bsize: 4096, blocks: 100_000_000 }); // ~40GB free
    expect(await hasSufficientDiskSpace('/tmp/archives')).toBe(true);
  });

  it('does not block a capture just because the space check itself failed', async () => {
    statfsMock.mockRejectedValue(new Error('EPERM'));
    expect(await hasSufficientDiskSpace('/tmp/archives')).toBe(true);
  });
});

describe('writeWithEnospcRetry', () => {
  it('succeeds on the first try when the write does not fail', async () => {
    const write = vi.fn().mockResolvedValue('ok');
    await expect(writeWithEnospcRetry(write, [1, 1])).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries a write that fails with ENOSPC and returns the eventual success', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(enospcError())
      .mockRejectedValueOnce(enospcError())
      .mockResolvedValueOnce('recovered');
    // Zero-length delays so the test doesn't actually wait -- this test is
    // about retry *behavior*, not the real backoff schedule (covered by
    // ENOSPC_RETRY_DELAYS_MS separately below).
    await expect(writeWithEnospcRetry(write, [0, 0, 0])).resolves.toBe('recovered');
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('throws a distinct DiskFullError once the retry schedule is exhausted', async () => {
    const write = vi.fn().mockRejectedValue(enospcError());
    await expect(writeWithEnospcRetry(write, [0, 0])).rejects.toBeInstanceOf(DiskFullError);
    // Initial attempt + one retry per configured delay.
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('never retries a failure that is not ENOSPC', async () => {
    const permissionError = new Error('EACCES: permission denied');
    const write = vi.fn().mockRejectedValue(permissionError);
    await expect(writeWithEnospcRetry(write, [0, 0])).rejects.toBe(permissionError);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('defaults to a non-empty backoff schedule, so production retries actually wait', async () => {
    const { ENOSPC_RETRY_DELAYS_MS } = await import('../../src/main/capture/diskSpace');
    expect(ENOSPC_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(ENOSPC_RETRY_DELAYS_MS.every((ms) => ms > 0)).toBe(true);
  });
});
