import { promises as fs } from 'node:fs';
import { logger } from '../util/logger';

export interface DiskSpaceInfo {
  freeBytes: number;
  totalBytes: number;
}

/**
 * Best-effort free-space check. `fs.statfs` is available cross-platform on
 * modern Node, but we still degrade gracefully (return null, log once)
 * rather than block captures if it's ever unavailable on some platform
 * quirk -- a failed space check should never itself crash browsing.
 */
export async function getDiskSpace(targetDir: string): Promise<DiskSpaceInfo | null> {
  try {
    await fs.mkdir(targetDir, { recursive: true });
    const stats = await fs.statfs(targetDir);
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch (err) {
    logger.warn('diskspace.check_failed', { error: String(err) });
    return null;
  }
}

const MIN_FREE_BYTES_SAFETY_MARGIN = 200 * 1024 * 1024; // 200MB headroom

export async function hasSufficientDiskSpace(targetDir: string): Promise<boolean> {
  const info = await getDiskSpace(targetDir);
  if (!info) return true; // unknown -> don't block
  return info.freeBytes > MIN_FREE_BYTES_SAFETY_MARGIN;
}

/**
 * A write failed because the disk genuinely ran out of space (ENOSPC),
 * even after retrying -- distinct from an ordinary I/O failure so callers
 * can record a failure kind that tells the user what actually happened and
 * that it's recoverable (free some space, then use "Retry failed pages"),
 * rather than a generic "render failed".
 */
export class DiskFullError extends Error {
  constructor(message = 'Ran out of disk space while writing to the archive.') {
    super(message);
    this.name = 'DiskFullError';
  }
}

function isEnospc(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOSPC';
}

/**
 * Backoff schedule for retrying a write that hit ENOSPC mid-capture.
 *
 * The free-space floor (hasSufficientDiskSpace) is only checked before a
 * capture starts -- a long crawl writing gigabytes can still run the disk
 * dry between checks. A few seconds' worth of retries gives a user who
 * notices (empties trash, deletes a file) a real chance for the exact same
 * write to succeed; anything that takes longer than this is what "Retry
 * failed pages" exists for, so the schedule is deliberately short rather
 * than blocking a whole crawl for minutes on one stuck write.
 */
export const ENOSPC_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 8000];

/**
 * Runs `write()`, retrying with backoff only when it fails specifically
 * with ENOSPC. Any other error (permissions, a bad path) propagates
 * immediately -- retrying those would just fail the same way every time.
 * Exhausting the schedule throws DiskFullError rather than letting the raw
 * ENOSPC escape and be recorded as an ordinary, less-actionable failure.
 */
export async function writeWithEnospcRetry<T>(
  write: () => Promise<T>,
  delaysMs: readonly number[] = ENOSPC_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (err) {
      if (!isEnospc(err)) throw err;
      if (attempt >= delaysMs.length) throw new DiskFullError();
      logger.warn('diskspace.write_enospc_retry', { attempt, delayMs: delaysMs[attempt] });
      await new Promise<void>((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
