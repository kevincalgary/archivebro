import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

/**
 * Move the contents of `fromDir` into `toDir` when the user changes the
 * archive storage location in Settings. Tries a fast `rename()` first
 * (atomic, instant on the same filesystem); falls back to a recursive
 * copy-then-delete for cross-device moves, since `fs.rename` can't cross
 * filesystem/volume boundaries.
 */
export async function moveArchiveStorage(fromDir: string, toDir: string): Promise<void> {
  if (path.resolve(fromDir) === path.resolve(toDir)) return;

  await fs.mkdir(path.dirname(toDir), { recursive: true });

  let fromExists = true;
  try {
    await fs.access(fromDir);
  } catch {
    fromExists = false;
  }
  if (!fromExists) {
    await fs.mkdir(toDir, { recursive: true });
    return;
  }

  const destEntries = await fs.readdir(toDir).catch(() => [] as string[]);
  if (destEntries.length > 0) {
    // Destination isn't empty (e.g. re-selecting a folder with existing
    // archives already in it) -- merge by moving each entry individually
    // rather than trying to rename the whole directory over it.
    const entries = await fs.readdir(fromDir);
    for (const entry of entries) {
      await moveEntry(path.join(fromDir, entry), path.join(toDir, entry));
    }
    await fs.rm(fromDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  await moveEntry(fromDir, toDir);
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      logger.info('storage.cross_device_move', {});
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
