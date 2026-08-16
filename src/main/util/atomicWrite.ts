import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Write `data` to `finalPath` by first writing to a sibling temp file and
 * then renaming it into place. rename() is atomic on the same filesystem,
 * so a process crash or power loss can never leave `finalPath` half
 * written -- readers either see the old file (or nothing) or the fully
 * written new one.
 */
export async function atomicWriteFile(finalPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(finalPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, finalPath);
}

/**
 * Stage a whole archive directory under `<archivesRoot>/.tmp-<id>` and
 * rename it into its final `<archivesRoot>/<id>` location only once every
 * file has been written successfully. If the process dies mid-capture, the
 * `.tmp-*` directory is left behind (never a partially-written final
 * directory) and is swept up by the startup recovery pass.
 */
export async function withStagedArchiveDir<T>(
  archivesRoot: string,
  archiveId: string,
  finalDir: string,
  fn: (stagingDir: string) => Promise<T>,
): Promise<T> {
  const stagingDir = path.join(archivesRoot, `.tmp-${archiveId}`);
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    const result = await fn(stagingDir);
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(stagingDir, finalDir);
    return result;
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Remove any leftover `.tmp-*` staging directories from a previous run. */
export async function sweepStagingDirs(archivesRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(archivesRoot);
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.tmp-')) {
      await fs.rm(path.join(archivesRoot, entry), { recursive: true, force: true }).catch(() => {});
      swept.push(entry);
    }
  }
  return swept;
}
