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
