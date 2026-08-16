import type { ArchiveRepo } from '../db/archiveRepo';
import { sweepStagingDirs } from '../util/atomicWrite';
import { logger } from '../util/logger';

/**
 * Runs once at startup, before any tab is created. Two things can be left
 * behind by a process that died mid-capture:
 *  1. A `.tmp-<archive-id>` staging directory under the archives root --
 *     removed here; since a capture only becomes a real archive via the
 *     atomic rename in withStagedArchiveDir, a leftover staging dir was
 *     never a complete, catalogued archive to begin with.
 *  2. A row in `interrupted_captures` -- the capture never reached
 *     markCaptureFinished, which also means the corresponding `archives`
 *     row was never inserted (insert happens after the rename succeeds),
 *     so there's nothing to roll back in the catalog; we just clear the
 *     bookkeeping row.
 */
export async function recoverFromInterruptedCaptures(repo: ArchiveRepo, archivesRoot: string): Promise<void> {
  const swept = await sweepStagingDirs(archivesRoot);
  if (swept.length > 0) {
    logger.info('recovery.swept_staging_dirs', { count: swept.length });
  }

  const interrupted = repo.listInterruptedCaptureIds();
  for (const archiveId of interrupted) {
    const existing = repo.getById(archiveId);
    if (!existing) {
      repo.markCaptureFinished(archiveId);
    }
  }
  if (interrupted.length > 0) {
    logger.info('recovery.cleared_interrupted_captures', { count: interrupted.length });
  }
}
