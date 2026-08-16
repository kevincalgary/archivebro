import { describe, it, expect, vi, beforeEach } from 'vitest';

const statfsMock = vi.fn();
const mkdirMock = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs', () => ({
  promises: {
    statfs: (...args: unknown[]) => statfsMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
  },
}));

const { getDiskSpace, hasSufficientDiskSpace } = await import('../../src/main/capture/diskSpace');

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
