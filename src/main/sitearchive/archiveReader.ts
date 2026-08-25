import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import Database from 'better-sqlite3';
import type { SiteArchiveManifest, RouteMapEntry, SiteArchiveSearchResult } from '../../shared/sitearchiveTypes';
import { SITEARCHIVE_FORMAT_VERSION } from '../../shared/sitearchiveTypes';
import { logger } from '../util/logger';
import { sanitizeFtsQuery } from '../util/ftsQuery';

/**
 * Reading a .sitearchive means reading an untrusted file that may have
 * been crafted by someone else (it's a portable format users will share).
 * Every gate below runs BEFORE any entry's bytes are used:
 *
 *  1. Entry names are normalized and rejected if absolute, containing
 *     "..", backslash-escaped, or resolving outside the archive root.
 *  2. Per-entry and whole-archive uncompressed size caps.
 *  3. Compression-ratio cap, to stop zip bombs (a 1KB entry claiming to
 *     expand to 10GB never gets read).
 *  4. Entry count cap.
 *  5. Entries not listed in the manifest are ignored entirely; manifest
 *     entries have their SHA-256 verified before the bytes are served.
 */
export const READ_LIMITS = {
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 200_000,
  maxCompressionRatio: 200,
  maxManifestBytes: 64 * 1024 * 1024,
} as const;

export class SiteArchiveError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SiteArchiveError';
  }
}

/**
 * Validate a zip entry name. Returns the safe archive-relative path, or
 * null if the name must be rejected.
 */
export function safeEntryName(rawName: string): string | null {
  if (!rawName || rawName.length > 1024) return null;
  // Zip spec uses forward slashes; a backslash here is an attempt to
  // exploit Windows path handling.
  if (rawName.includes('\\')) return null;
  if (rawName.includes('\0')) return null;
  // Directory entries are not content and are never served.
  if (rawName.endsWith('/')) return null;
  if (path.posix.isAbsolute(rawName)) return null;
  // Reject drive-letter and UNC style prefixes outright.
  if (/^[a-zA-Z]:/.test(rawName) || rawName.startsWith('//')) return null;

  const normalized = path.posix.normalize(rawName);
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '.') return null;
  if (path.posix.isAbsolute(normalized)) return null;

  const segments = normalized.split('/');
  if (segments.some((s) => s === '..' || s === '')) return null;

  return normalized;
}

/**
 * Resolve an archive-relative path under a root directory, guaranteeing
 * the result stays inside that root even if `relPath` is hostile.
 */
export function resolveInsideRoot(root: string, relPath: string): string | null {
  const safe = safeEntryName(relPath);
  if (!safe) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safe);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

interface RawEntry {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
}

// Exported (not just used by OpenedArchive) so libraryTransfer.ts -- which
// reads a different, unrelated zip format for whole-library export/import
// -- can reuse the same safe-open/bounded-read primitives instead of a
// second implementation that could drift from this one.
export function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new SiteArchiveError('Could not open archive', 'open-failed'));
        return;
      }
      resolve(zipfile);
    });
  });
}

export function readEntryBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new SiteArchiveError('Could not read archive entry', 'entry-read-failed'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        // Enforce the cap during streaming too: a lying central-directory
        // size must not let us buffer unbounded data.
        if (total > maxBytes) {
          stream.destroy();
          reject(new SiteArchiveError('Archive entry exceeds size limit', 'entry-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (e: Error) => reject(e));
    });
  });
}

/**
 * An opened, validated .sitearchive. Entries are read on demand and
 * checksum-verified against the manifest; nothing is extracted to disk.
 */
export class OpenedArchive {
  private routeIndex: Map<string, RouteMapEntry>;
  private pageById: Map<string, SiteArchiveManifest['pages'][number]>;
  private assetByHash: Map<string, SiteArchiveManifest['assets'][number]>;
  private responseByHash: Map<string, SiteArchiveManifest['responses'][number]>;
  private entryByName: Map<string, yauzl.Entry>;
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private static readonly MAX_CACHE_BYTES = 64 * 1024 * 1024;
  /**
   * The archive's index.sqlite catalog, extracted to a real file so
   * better-sqlite3 can open it (it has no API for opening a database
   * straight out of an in-memory buffer). Search is a nice-to-have on top
   * of browsing, so a missing or corrupt catalog just means `search()`
   * returns no results rather than the archive failing to open -- see
   * openSiteArchive()'s best-effort initSearchIndex() call.
   */
  private indexDb: Database.Database | null = null;
  private indexDbTempPath: string | null = null;

  constructor(
    readonly archivePath: string,
    readonly manifest: SiteArchiveManifest,
    private zipfile: yauzl.ZipFile,
    entries: Map<string, yauzl.Entry>,
  ) {
    this.entryByName = entries;
    this.routeIndex = new Map(manifest.routes.map((r) => [r.normalizedUrl, r]));
    this.pageById = new Map(manifest.pages.map((p) => [p.pageId, p]));
    this.assetByHash = new Map(manifest.assets.map((a) => [a.sha256, a]));
    this.responseByHash = new Map(manifest.responses.map((r) => [r.sha256, r]));
  }

  get entryPageId(): string | null {
    // Prefer the page matching the start URL; fall back to the first page.
    const start = this.manifest.pages.find(
      (p) => p.finalUrl === this.manifest.startFinalUrl || p.originalUrl === this.manifest.startUrl,
    );
    return start?.pageId ?? this.manifest.pages[0]?.pageId ?? null;
  }

  lookupRoute(normalizedUrl: string): RouteMapEntry | null {
    return this.routeIndex.get(normalizedUrl) ?? null;
  }

  getPage(pageId: string) {
    return this.pageById.get(pageId) ?? null;
  }

  getAsset(sha: string) {
    return this.assetByHash.get(sha) ?? null;
  }

  getResponse(sha: string) {
    return this.responseByHash.get(sha) ?? null;
  }

  /**
   * Extract index.sqlite to a temp file and open it, so `search()` has
   * something to query. Named deterministically per archive id (not a
   * random name) so re-opening the same archive overwrites rather than
   * accumulating a new temp file on every open.
   */
  async initSearchIndex(buffer: Buffer): Promise<void> {
    const tempPath = path.join(os.tmpdir(), `archive-browser-search-index-${this.manifest.archiveId}.sqlite`);
    await fs.writeFile(tempPath, buffer);
    this.indexDbTempPath = tempPath;
    this.indexDb = new Database(tempPath, { readonly: true });
  }

  /** Full-text search over every captured page's title + extracted text. */
  search(query: string, limit = 30): SiteArchiveSearchResult[] {
    if (!this.indexDb) return [];
    const q = sanitizeFtsQuery(query.trim());
    if (!q) return [];

    try {
      const rows = this.indexDb
        .prepare(
          `SELECT page_id, snippet(pages_fts, 2, '', '', '…', 12) AS snippet
           FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(q, limit) as Array<{ page_id: string; snippet: string }>;

      const results: SiteArchiveSearchResult[] = [];
      for (const row of rows) {
        const page = this.pageById.get(row.page_id);
        if (!page) continue; // stale row from a mismatched catalog -- skip rather than throw
        results.push({ pageId: row.page_id, title: page.title, normalizedUrl: page.normalizedUrl, snippet: row.snippet });
      }
      return results;
    } catch (err) {
      // A malformed query or corrupt index shouldn't break browsing --
      // search just comes back empty.
      logger.warn('sitearchive.search_failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Read one manifest-declared entry, verifying its SHA-256 before
   * returning it. `expectedSha` null means the manifest didn't record one
   * (only used for entries where a hash isn't meaningful).
   */
  async readEntry(relPath: string, expectedSha: string | null): Promise<Buffer> {
    const cached = this.cache.get(relPath);
    if (cached) return cached;

    const safe = safeEntryName(relPath);
    if (!safe) throw new SiteArchiveError(`Unsafe entry path: ${relPath}`, 'unsafe-path');

    const entry = this.entryByName.get(safe);
    if (!entry) throw new SiteArchiveError(`Entry not present in archive: ${safe}`, 'entry-missing');

    const buf = await readEntryBuffer(this.zipfile, entry, READ_LIMITS.maxEntryUncompressedBytes);

    if (expectedSha) {
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== expectedSha) {
        logger.error('sitearchive.checksum_mismatch', { entry: safe });
        throw new SiteArchiveError(`Checksum mismatch for ${safe} -- archive may be corrupt or tampered with`, 'checksum-mismatch');
      }
    }

    if (this.cacheBytes + buf.length <= OpenedArchive.MAX_CACHE_BYTES) {
      this.cache.set(relPath, buf);
      this.cacheBytes += buf.length;
    }
    return buf;
  }

  close(): void {
    this.cache.clear();
    this.cacheBytes = 0;
    try {
      this.zipfile.close();
    } catch {
      // already closed
    }
    if (this.indexDb) {
      try {
        this.indexDb.close();
      } catch {
        // already closed
      }
      this.indexDb = null;
    }
    if (this.indexDbTempPath) {
      const tempPath = this.indexDbTempPath;
      this.indexDbTempPath = null;
      void fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Open and validate a .sitearchive. Throws SiteArchiveError with a
 * specific `code` for every rejection reason so the UI can explain what
 * was wrong rather than showing a generic failure.
 */
export async function openSiteArchive(archivePath: string): Promise<OpenedArchive> {
  const stat = await fs.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new SiteArchiveError('Archive file not found', 'not-found');
  }

  const zipfile = await openZip(archivePath);

  const entries = new Map<string, yauzl.Entry>();
  const raw: RawEntry[] = [];
  let totalUncompressed = 0;

  await new Promise<void>((resolve, reject) => {
    let count = 0;
    zipfile.on('entry', (entry: yauzl.Entry) => {
      count += 1;
      if (count > READ_LIMITS.maxEntries) {
        reject(new SiteArchiveError('Archive contains too many entries', 'too-many-entries'));
        return;
      }

      const safe = safeEntryName(entry.fileName);
      if (!safe) {
        // Silently skip unsafe names (directories, traversal attempts) --
        // the manifest is the authority for what we actually read, so a
        // rejected name simply becomes an unreadable entry later.
        if (!entry.fileName.endsWith('/')) {
          logger.warn('sitearchive.rejected_entry_name', {});
        }
        zipfile.readEntry();
        return;
      }

      const uncompressed = Number(entry.uncompressedSize);
      const compressed = Number(entry.compressedSize);

      if (uncompressed > READ_LIMITS.maxEntryUncompressedBytes) {
        reject(new SiteArchiveError(`Archive entry too large: ${safe}`, 'entry-too-large'));
        return;
      }
      // Zip-bomb guard: absurd expansion ratios are rejected before any
      // decompression happens. Small entries are exempt because tiny files
      // legitimately compress at extreme ratios.
      if (compressed > 0 && uncompressed / compressed > READ_LIMITS.maxCompressionRatio && uncompressed > 1024 * 1024) {
        reject(new SiteArchiveError(`Archive entry has a suspicious compression ratio: ${safe}`, 'compression-bomb'));
        return;
      }

      totalUncompressed += uncompressed;
      if (totalUncompressed > READ_LIMITS.maxTotalUncompressedBytes) {
        reject(new SiteArchiveError('Archive total uncompressed size exceeds limit', 'archive-too-large'));
        return;
      }

      entries.set(safe, entry);
      raw.push({ name: safe, uncompressedSize: uncompressed, compressedSize: compressed });
      zipfile.readEntry();
    });
    zipfile.on('end', () => resolve());
    zipfile.on('error', (err: Error) => reject(err));
    zipfile.readEntry();
  }).catch((err) => {
    try {
      zipfile.close();
    } catch {
      /* ignore */
    }
    throw err;
  });

  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) {
    zipfile.close();
    throw new SiteArchiveError('Archive is missing manifest.json', 'missing-manifest');
  }

  let manifest: SiteArchiveManifest;
  try {
    const manifestBuf = await readEntryBuffer(zipfile, manifestEntry, READ_LIMITS.maxManifestBytes);
    manifest = JSON.parse(manifestBuf.toString('utf8')) as SiteArchiveManifest;
  } catch (err) {
    zipfile.close();
    if (err instanceof SiteArchiveError) throw err;
    throw new SiteArchiveError('Archive manifest is malformed', 'malformed-manifest');
  }

  const validationError = validateManifestShape(manifest);
  if (validationError) {
    zipfile.close();
    throw new SiteArchiveError(validationError, 'malformed-manifest');
  }

  if (manifest.formatVersion > SITEARCHIVE_FORMAT_VERSION) {
    zipfile.close();
    throw new SiteArchiveError(
      `Archive was created by a newer version of Archive Browser (format v${manifest.formatVersion}).`,
      'unsupported-version',
    );
  }

  // Every path the manifest references must itself be a safe name. This
  // stops a hostile manifest from pointing at "../../etc/passwd" even if
  // the zip's own entry names were clean.
  const referenced = [
    ...manifest.pages.flatMap((p) => [p.htmlPath, p.screenshotPath, p.textPath]),
    ...manifest.assets.map((a) => a.path),
    ...manifest.responses.map((r) => r.path),
    manifest.indexPath,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const ref of referenced) {
    if (!safeEntryName(ref)) {
      zipfile.close();
      throw new SiteArchiveError(`Manifest references an unsafe path: ${ref}`, 'unsafe-path');
    }
  }

  logger.info('sitearchive.opened', {
    pages: manifest.pages.length,
    assets: manifest.assets.length,
    formatVersion: manifest.formatVersion,
  });

  const archive = new OpenedArchive(archivePath, manifest, zipfile, entries);

  // Best-effort: search is a convenience on top of browsing, not required
  // to open the archive at all. An archive from before this feature has no
  // indexPath; one with a corrupt or checksum-mismatched catalog just
  // means search() returns no results rather than the whole open failing.
  if (manifest.indexPath && manifest.indexSha256) {
    try {
      const indexBuffer = await archive.readEntry(manifest.indexPath, manifest.indexSha256);
      await archive.initSearchIndex(indexBuffer);
    } catch (err) {
      logger.warn('sitearchive.search_index_unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return archive;
}

function validateManifestShape(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'Manifest is not an object';
  const man = m as Partial<SiteArchiveManifest>;
  if (typeof man.formatVersion !== 'number') return 'Manifest is missing formatVersion';
  if (typeof man.archiveId !== 'string' || !man.archiveId) return 'Manifest is missing archiveId';
  if (!Array.isArray(man.pages)) return 'Manifest is missing pages';
  if (!Array.isArray(man.assets)) return 'Manifest is missing assets';
  if (!Array.isArray(man.routes)) return 'Manifest is missing routes';
  if (!Array.isArray(man.responses)) return 'Manifest is missing responses';
  if (!Array.isArray(man.failures)) return 'Manifest is missing failures';

  for (const p of man.pages) {
    if (typeof p?.pageId !== 'string' || typeof p?.htmlPath !== 'string' || typeof p?.htmlSha256 !== 'string') {
      return 'Manifest contains a malformed page entry';
    }
  }
  for (const a of man.assets) {
    if (typeof a?.sha256 !== 'string' || typeof a?.path !== 'string') {
      return 'Manifest contains a malformed asset entry';
    }
  }
  return null;
}
