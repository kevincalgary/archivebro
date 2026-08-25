import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import type yauzl from 'yauzl';
import type { ArchiveRepo, ArchiveExportEntry } from '../db/archiveRepo';
import type { ArchiveRecord, CaptureWarning } from '../../shared/types';
import { archiveDirFor, archiveFilePaths, isValidArchiveId } from '../util/paths';
import { atomicWriteFile, withStagedArchiveDir } from '../util/atomicWrite';
import { sha256Hex } from '../util/hash';
import { openZip, readEntryBuffer, safeEntryName } from '../sitearchive/archiveReader';
import { logger } from '../util/logger';

/**
 * Whole-library export/import: every archive's DB row plus whatever
 * content files it actually has, as one portable zip -- for migrating a
 * library between machines or keeping an off-machine backup. A separate
 * format from `.sitearchive` (a single captured *website*); this is the
 * user's whole local Library (every page they've ever visited).
 */
export const LIBRARY_EXPORT_FORMAT_VERSION = 1;

export interface LibraryExportManifest {
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  archives: ArchiveExportEntry[];
}

export class LibraryTransferError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LibraryTransferError';
  }
}

// A whole library can be far larger than a single .sitearchive (every
// page ever visited, not one site), so these ceilings are generous, but
// still bounded -- this is untrusted input the moment it's a file someone
// received rather than one they just made themselves.
const LIMITS = {
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024 * 1024,
  maxEntries: 2_000_000,
  maxCompressionRatio: 200,
  maxManifestBytes: 256 * 1024 * 1024,
} as const;

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'failed',
  'skipped-excluded',
  'skipped-private',
  'skipped-non-http',
]);

/**
 * A library-manifest.json is untrusted input the moment it's a file
 * someone received rather than one they just made themselves. A field of
 * the wrong shape here (e.g. `warnings` not actually an array) wouldn't
 * throw at insert time -- better-sqlite3 just serializes whatever it's
 * given -- so it would silently poison warnings_json/tags_json with
 * un-parseable JSON, breaking every later read of that row (and,
 * un-caught, potentially the whole Library listing). Reject before any of
 * that happens instead.
 */
function isValidExportEntry(entry: unknown): entry is ArchiveExportEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string') return false;
  if (typeof e.canonicalUrl !== 'string') return false;
  if (typeof e.originalUrl !== 'string') return false;
  if (typeof e.finalUrl !== 'string') return false;
  if (typeof e.title !== 'string') return false;
  if (typeof e.domain !== 'string') return false;
  if (e.referrerUrl !== null && typeof e.referrerUrl !== 'string') return false;
  if (typeof e.capturedAt !== 'string') return false;
  if (typeof e.visitedAt !== 'string') return false;
  if (typeof e.status !== 'string' || !VALID_STATUSES.has(e.status)) return false;
  if (!Array.isArray(e.warnings)) return false;
  if (typeof e.sizeBytes !== 'number') return false;
  if (typeof e.appVersion !== 'string') return false;
  if (typeof e.schemaVersion !== 'number') return false;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) return false;
  if (typeof e.hasMhtml !== 'boolean') return false;
  if (typeof e.hasScreenshot !== 'boolean') return false;
  if (typeof e.hasText !== 'boolean') return false;
  if (typeof e.hasFavicon !== 'boolean') return false;
  if (e.mhtmlSha256 !== null && typeof e.mhtmlSha256 !== 'string') return false;
  if (e.screenshotSha256 !== null && typeof e.screenshotSha256 !== 'string') return false;
  if (e.textSha256 !== null && typeof e.textSha256 !== 'string') return false;
  return true;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function exportLibrary(
  archivesRoot: string,
  repo: ArchiveRepo,
  destZipPath: string,
  appVersion: string,
): Promise<{ archiveCount: number }> {
  const rows = repo.listAllForExport();
  const manifestEntries: ArchiveExportEntry[] = [];
  const filesToZip: { fullPath: string; zipName: string }[] = [];

  for (const row of rows) {
    const paths = archiveFilePaths(archivesRoot, row.id);
    const hasMhtml = row.hasMhtml && (await fileExists(paths.mhtml));
    const hasScreenshot = row.hasScreenshot && (await fileExists(paths.screenshot));
    const hasText = row.hasText && (await fileExists(paths.text));
    const hasFavicon = row.hasFavicon && (await fileExists(paths.favicon));
    if (hasMhtml) filesToZip.push({ fullPath: paths.mhtml, zipName: `archives/${row.id}/page.mhtml` });
    if (hasScreenshot) filesToZip.push({ fullPath: paths.screenshot, zipName: `archives/${row.id}/screenshot.png` });
    if (hasText) filesToZip.push({ fullPath: paths.text, zipName: `archives/${row.id}/text.txt` });
    if (hasFavicon) filesToZip.push({ fullPath: paths.favicon, zipName: `archives/${row.id}/favicon.png` });
    // hasMhtml/etc reflect a file actually found on disk right now, not
    // just what the DB row claims -- a stale claim would otherwise export
    // a manifest entry promising bytes that were never in the zip.
    manifestEntries.push({ ...row, hasMhtml, hasScreenshot, hasText, hasFavicon });
  }

  const manifest: LibraryExportManifest = {
    formatVersion: LIBRARY_EXPORT_FORMAT_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    archives: manifestEntries,
  };

  // archiver ships ESM-only; this file compiles to CommonJS, so a dynamic
  // import() is required rather than require() (see zipExport.ts).
  const { ZipArchive } = await import('archiver');

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', (err: unknown) => reject(err));
    output.on('error', (err: unknown) => reject(err));
    archive.pipe(output);
    for (const f of filesToZip) archive.file(f.fullPath, { name: f.zipName });
    archive.append(JSON.stringify(manifest, null, 2), { name: 'library-manifest.json' });
    void archive.finalize();
  });

  return { archiveCount: rows.length };
}

/**
 * Read one expected content file out of the import zip, verifying its
 * SHA-256 against the manifest's recorded hash before trusting it. Returns
 * null (not a throw) when the entry is simply absent or fails
 * verification -- a partially-recoverable archive is more useful than
 * aborting the whole entry, and the caller only marks `has*` true for
 * what actually came back.
 */
async function readVerifiedEntry(
  zipfile: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  name: string,
  expectedSha: string | null,
): Promise<Buffer | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  let buf: Buffer;
  try {
    buf = await readEntryBuffer(zipfile, entry, LIMITS.maxEntryUncompressedBytes);
  } catch (err) {
    logger.warn('library.import_entry_unreadable', { name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (expectedSha && sha256Hex(buf) !== expectedSha) {
    logger.error('library.import_checksum_mismatch', { name });
    return null;
  }
  return buf;
}

export interface LibraryImportResult {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}

export async function importLibrary(
  zipPath: string,
  archivesRoot: string,
  repo: ArchiveRepo,
): Promise<LibraryImportResult> {
  const stat = await fs.stat(zipPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new LibraryTransferError('Library export file not found', 'not-found');
  }

  const zipfile = await openZip(zipPath);
  const entries = new Map<string, yauzl.Entry>();

  try {
    await new Promise<void>((resolve, reject) => {
      let count = 0;
      let totalUncompressed = 0;
      zipfile.on('entry', (entry: yauzl.Entry) => {
        count += 1;
        if (count > LIMITS.maxEntries) {
          reject(new LibraryTransferError('Export contains too many entries', 'too-many-entries'));
          return;
        }
        const safe = safeEntryName(entry.fileName);
        if (!safe) {
          zipfile.readEntry();
          return;
        }
        const uncompressed = Number(entry.uncompressedSize);
        const compressed = Number(entry.compressedSize);
        if (uncompressed > LIMITS.maxEntryUncompressedBytes) {
          reject(new LibraryTransferError(`Export entry too large: ${safe}`, 'entry-too-large'));
          return;
        }
        if (compressed > 0 && uncompressed / compressed > LIMITS.maxCompressionRatio && uncompressed > 1024 * 1024) {
          reject(new LibraryTransferError(`Export entry has a suspicious compression ratio: ${safe}`, 'compression-bomb'));
          return;
        }
        totalUncompressed += uncompressed;
        if (totalUncompressed > LIMITS.maxTotalUncompressedBytes) {
          reject(new LibraryTransferError('Export total uncompressed size exceeds limit', 'export-too-large'));
          return;
        }
        entries.set(safe, entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', (err: Error) => reject(err));
      zipfile.readEntry();
    });

    const manifestEntry = entries.get('library-manifest.json');
    if (!manifestEntry) {
      throw new LibraryTransferError('Export is missing library-manifest.json', 'missing-manifest');
    }
    const manifestBuf = await readEntryBuffer(zipfile, manifestEntry, LIMITS.maxManifestBytes);
    let manifest: LibraryExportManifest;
    try {
      manifest = JSON.parse(manifestBuf.toString('utf8')) as LibraryExportManifest;
    } catch {
      throw new LibraryTransferError('Library manifest is malformed', 'malformed-manifest');
    }
    if (!manifest || typeof manifest.formatVersion !== 'number' || !Array.isArray(manifest.archives)) {
      throw new LibraryTransferError('Library manifest is malformed', 'malformed-manifest');
    }
    if (manifest.formatVersion > LIBRARY_EXPORT_FORMAT_VERSION) {
      throw new LibraryTransferError(
        `Export was created by a newer version of Archive Browser (format v${manifest.formatVersion}).`,
        'unsupported-version',
      );
    }

    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const entry of manifest.archives) {
      try {
        if (!isValidExportEntry(entry) || !isValidArchiveId(entry.id)) {
          failedCount += 1;
          continue;
        }
        // id is the primary key: a row with this id already occupying it
        // -- deleted or not -- must be skipped, never re-inserted.
        if (repo.existsAnyById(entry.id)) {
          skippedCount += 1;
          continue;
        }

        const finalDir = archiveDirFor(archivesRoot, entry.id);
        let hasMhtml = false;
        let hasScreenshot = false;
        let hasText = false;
        let hasFavicon = false;
        let mhtmlSha256: string | null = null;
        let screenshotSha256: string | null = null;
        let textSha256: string | null = null;
        let textContent = '';
        let sizeBytes = 0;
        const importWarnings: CaptureWarning[] = [];

        await withStagedArchiveDir(archivesRoot, entry.id, finalDir, async (stagingDir) => {
          if (entry.hasMhtml) {
            const buf = await readVerifiedEntry(
              zipfile,
              entries,
              `archives/${entry.id}/page.mhtml`,
              entry.mhtmlSha256,
            );
            if (buf) {
              await atomicWriteFile(path.join(stagingDir, 'page.mhtml'), buf);
              hasMhtml = true;
              mhtmlSha256 = entry.mhtmlSha256;
              sizeBytes += buf.length;
            } else {
              importWarnings.push({ code: 'import-content-missing', message: 'page.mhtml could not be verified during import and was dropped' });
            }
          }
          if (entry.hasScreenshot) {
            const buf = await readVerifiedEntry(
              zipfile,
              entries,
              `archives/${entry.id}/screenshot.png`,
              entry.screenshotSha256,
            );
            if (buf) {
              await atomicWriteFile(path.join(stagingDir, 'screenshot.png'), buf);
              hasScreenshot = true;
              screenshotSha256 = entry.screenshotSha256;
              sizeBytes += buf.length;
            } else {
              importWarnings.push({ code: 'import-content-missing', message: 'screenshot.png could not be verified during import and was dropped' });
            }
          }
          if (entry.hasText) {
            const buf = await readVerifiedEntry(zipfile, entries, `archives/${entry.id}/text.txt`, entry.textSha256);
            if (buf) {
              await atomicWriteFile(path.join(stagingDir, 'text.txt'), buf);
              hasText = true;
              textSha256 = entry.textSha256;
              textContent = buf.toString('utf8');
              sizeBytes += buf.length;
            } else {
              importWarnings.push({ code: 'import-content-missing', message: 'text.txt could not be verified during import and was dropped' });
            }
          }
          if (entry.hasFavicon) {
            const buf = await readVerifiedEntry(zipfile, entries, `archives/${entry.id}/favicon.png`, null);
            if (buf) {
              await atomicWriteFile(path.join(stagingDir, 'favicon.png'), buf);
              hasFavicon = true;
              sizeBytes += buf.length;
            }
          }
        });

        repo.insert({
          id: entry.id,
          canonicalUrl: entry.canonicalUrl,
          originalUrl: entry.originalUrl,
          finalUrl: entry.finalUrl,
          title: entry.title,
          domain: entry.domain,
          // Recomputed from what actually landed on this machine's disk,
          // never trusted from the export -- an absolute path exported
          // from another machine would point nowhere real here.
          faviconPath: hasFavicon ? archiveFilePaths(archivesRoot, entry.id).favicon : null,
          referrerUrl: entry.referrerUrl,
          capturedAt: entry.capturedAt,
          visitedAt: entry.visitedAt,
          status: entry.status as ArchiveRecord['status'],
          warnings: [...(entry.warnings as CaptureWarning[]), ...importWarnings],
          sizeBytes,
          appVersion: entry.appVersion,
          schemaVersion: entry.schemaVersion,
          hasMhtml,
          hasScreenshot,
          hasText,
          mhtmlSha256,
          screenshotSha256,
          textSha256,
        });
        if (textContent) repo.updateExtractedText(entry.id, textContent);
        if (Array.isArray(entry.tags) && entry.tags.length > 0) repo.setTags(entry.id, entry.tags);

        importedCount += 1;
      } catch (err) {
        failedCount += 1;
        logger.warn('library.import_entry_failed', {
          id: typeof entry?.id === 'string' ? entry.id : '',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { importedCount, skippedCount, failedCount };
  } finally {
    zipfile.close();
  }
}
