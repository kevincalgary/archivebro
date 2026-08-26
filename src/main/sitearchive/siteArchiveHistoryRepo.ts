import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { SiteArchiveHistoryEntry, SiteArchiveManifest, CaptureFailureEntry } from '../../shared/sitearchiveTypes';

interface SiteArchiveCaptureRow {
  archive_id: string;
  output_path: string;
  site_title: string;
  start_url: string;
  scope_kind: string;
  captured_at: string;
  page_count: number;
  asset_count: number;
  file_size_bytes: number;
  thread_count: number | null;
  section_count: number | null;
  attachment_count: number | null;
  is_complete: number;
  incomplete_reason: string | null;
  failure_count: number;
}

function rowToEntry(row: SiteArchiveCaptureRow): SiteArchiveHistoryEntry {
  return {
    archiveId: row.archive_id,
    outputPath: row.output_path,
    siteTitle: row.site_title,
    startUrl: row.start_url,
    scopeKind: row.scope_kind as SiteArchiveHistoryEntry['scopeKind'],
    capturedAt: row.captured_at,
    pageCount: row.page_count,
    assetCount: row.asset_count,
    fileSizeBytes: row.file_size_bytes,
    threadCount: row.thread_count,
    sectionCount: row.section_count,
    attachmentCount: row.attachment_count,
    isComplete: row.is_complete === 1,
    incompleteReason: row.incomplete_reason,
    failureCount: row.failure_count,
    fileExists: existsSync(row.output_path),
  };
}

/** True when any failure entry represents the crawl stopping short of everything it could reach. */
function isManifestComplete(failures: readonly CaptureFailureEntry[]): { complete: boolean; reason: string | null } {
  const stop = failures.find((f) => f.kind === 'stopped-at-limit');
  if (stop) return { complete: false, reason: stop.message };
  return { complete: true, reason: null };
}

/**
 * Persistent, app-wide registry of completed `.sitearchive` captures --
 * separate from ArchiveRepo (the single-page auto-capture Library). A row
 * here is just an index of where a capture lives and its summary stats;
 * the archive's actual content is only ever the file itself. See
 * site_archive_captures in schema.ts.
 */
export class SiteArchiveHistoryRepo {
  constructor(private db: Database.Database) {}

  /** Insert or refresh one row from a finished manifest -- called on capture completion and on opening any .sitearchive not yet tracked. */
  upsertFromManifest(archiveId: string, outputPath: string, manifest: SiteArchiveManifest, fileSizeBytes: number): void {
    const { complete, reason } = isManifestComplete(manifest.failures);
    this.db
      .prepare(
        `INSERT INTO site_archive_captures
           (archive_id, output_path, site_title, start_url, scope_kind, captured_at, page_count, asset_count, file_size_bytes,
            thread_count, section_count, attachment_count, is_complete, incomplete_reason, failure_count)
         VALUES (@archiveId, @outputPath, @siteTitle, @startUrl, @scopeKind, @capturedAt, @pageCount, @assetCount, @fileSizeBytes,
                 @threadCount, @sectionCount, @attachmentCount, @isComplete, @incompleteReason, @failureCount)
         ON CONFLICT(archive_id) DO UPDATE SET
           output_path=excluded.output_path, site_title=excluded.site_title, start_url=excluded.start_url,
           scope_kind=excluded.scope_kind, captured_at=excluded.captured_at, page_count=excluded.page_count,
           asset_count=excluded.asset_count, file_size_bytes=excluded.file_size_bytes, thread_count=excluded.thread_count,
           section_count=excluded.section_count, attachment_count=excluded.attachment_count, is_complete=excluded.is_complete,
           incomplete_reason=excluded.incomplete_reason, failure_count=excluded.failure_count`,
      )
      .run({
        archiveId,
        outputPath,
        siteTitle: manifest.siteTitle,
        startUrl: manifest.startUrl,
        scopeKind: manifest.scope.kind,
        capturedAt: manifest.capturedAt,
        pageCount: manifest.pages.length,
        assetCount: manifest.assets.length,
        fileSizeBytes,
        threadCount: manifest.forumSummary?.threadCount ?? null,
        sectionCount: manifest.forumSummary?.sectionCount ?? null,
        attachmentCount: manifest.forumSummary?.attachmentCount ?? null,
        isComplete: complete ? 1 : 0,
        incompleteReason: reason,
        failureCount: manifest.failures.length,
      });
  }

  list(): SiteArchiveHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM site_archive_captures ORDER BY captured_at DESC')
      .all() as SiteArchiveCaptureRow[];
    return rows.map(rowToEntry);
  }

  get(archiveId: string): SiteArchiveHistoryEntry | null {
    const row = this.db.prepare('SELECT * FROM site_archive_captures WHERE archive_id = ?').get(archiveId) as
      | SiteArchiveCaptureRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  has(archiveId: string): boolean {
    return this.db.prepare('SELECT 1 FROM site_archive_captures WHERE archive_id = ?').get(archiveId) !== undefined;
  }

  /** Removes only the registry row -- never touches the file itself. */
  remove(archiveId: string): void {
    this.db.prepare('DELETE FROM site_archive_captures WHERE archive_id = ?').run(archiveId);
  }
}
