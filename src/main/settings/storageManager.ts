import { promises as fs } from 'node:fs';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { SettingsStore } from './settingsStore';
import { archiveDirFor } from '../util/paths';
import { logger } from '../util/logger';

/**
 * Enforces retention-days and max-disk-usage policies. Both are opt-in
 * (null by default) -- this function is a no-op unless the user has
 * explicitly configured one of them in Settings, per the requirement that
 * archived data is never deleted automatically otherwise.
 */
export async function enforceStoragePolicies(repo: ArchiveRepo, settings: SettingsStore): Promise<void> {
  const s = settings.get();
  const root = s.archiveStorageDir;

  if (s.retentionDays !== null) {
    const cutoff = new Date(Date.now() - s.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const expired = repo.listOldestActive(10_000).filter((a) => a.visitedAt < cutoff);
    for (const a of expired) {
      await deleteArchiveFiles(root, a.id);
      repo.softDelete(a.id);
      logger.info('retention.deleted', { archiveId: a.id });
    }
  }

  if (s.maxDiskUsageMb !== null) {
    const quotaBytes = s.maxDiskUsageMb * 1024 * 1024;
    let total = repo.totalSizeBytes();
    if (total > quotaBytes) {
      const candidates = repo.listOldestActive(10_000);
      for (const a of candidates) {
        if (total <= quotaBytes) break;
        await deleteArchiveFiles(root, a.id);
        repo.softDelete(a.id);
        total -= a.sizeBytes;
        logger.info('quota.evicted', { archiveId: a.id, sizeBytes: a.sizeBytes });
      }
    }
  }
}

async function deleteArchiveFiles(root: string, archiveId: string): Promise<void> {
  const dir = archiveDirFor(root, archiveId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
