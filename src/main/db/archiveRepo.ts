import type Database from 'better-sqlite3';
import type {
  ArchiveDetail,
  ArchiveRecord,
  CaptureWarning,
  LibraryPage,
  LibraryQuery,
  LibraryResultItem,
} from '../../shared/types';
import { SNIPPET_MARK_START, SNIPPET_MARK_END } from '../../shared/types';
import { sanitizeFtsQuery } from '../util/ftsQuery';

interface ArchiveRow {
  id: string;
  canonical_url: string;
  original_url: string;
  final_url: string;
  title: string;
  domain: string;
  favicon_path: string | null;
  referrer_url: string | null;
  captured_at: string;
  visited_at: string;
  status: ArchiveRecord['status'];
  warnings_json: string;
  size_bytes: number;
  app_version: string;
  schema_version: number;
  tags_json: string;
  notes: string | null;
  has_mhtml: number;
  has_screenshot: number;
  has_text: number;
  mhtml_sha256: string | null;
  screenshot_sha256: string | null;
  text_sha256: string | null;
  deleted: number;
}

function rowToRecord(row: ArchiveRow): ArchiveRecord {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    originalUrl: row.original_url,
    finalUrl: row.final_url,
    title: row.title,
    domain: row.domain,
    faviconPath: row.favicon_path,
    referrerUrl: row.referrer_url,
    capturedAt: row.captured_at,
    visitedAt: row.visited_at,
    status: row.status,
    warnings: JSON.parse(row.warnings_json) as CaptureWarning[],
    sizeBytes: row.size_bytes,
    appVersion: row.app_version,
    schemaVersion: row.schema_version,
    tags: JSON.parse(row.tags_json) as string[],
    notes: row.notes,
    deleted: row.deleted === 1,
  };
}

/** One archive's row + which content files it actually has, for whole-library export (see libraryTransfer.ts). */
export interface ArchiveExportEntry extends NewArchiveInput {
  tags: string[];
  hasFavicon: boolean;
}

export interface NewArchiveInput {
  id: string;
  canonicalUrl: string;
  originalUrl: string;
  finalUrl: string;
  title: string;
  domain: string;
  faviconPath: string | null;
  referrerUrl: string | null;
  capturedAt: string;
  visitedAt: string;
  status: ArchiveRecord['status'];
  warnings: CaptureWarning[];
  sizeBytes: number;
  appVersion: string;
  schemaVersion: number;
  hasMhtml: boolean;
  hasScreenshot: boolean;
  hasText: boolean;
  mhtmlSha256: string | null;
  screenshotSha256: string | null;
  textSha256: string | null;
}

export class ArchiveRepo {
  constructor(private db: Database.Database) {}

  insert(input: NewArchiveInput): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO archives (
            id, canonical_url, original_url, final_url, title, domain, favicon_path,
            referrer_url, captured_at, visited_at, status, warnings_json, size_bytes,
            app_version, schema_version, tags_json, notes, has_mhtml, has_screenshot, has_text,
            mhtml_sha256, screenshot_sha256, text_sha256, deleted
          ) VALUES (@id, @canonicalUrl, @originalUrl, @finalUrl, @title, @domain, @faviconPath,
            @referrerUrl, @capturedAt, @visitedAt, @status, @warningsJson, @sizeBytes,
            @appVersion, @schemaVersion, @tagsJson, NULL, @hasMhtml, @hasScreenshot, @hasText,
            @mhtmlSha256, @screenshotSha256, @textSha256, 0)`,
        )
        .run({
          ...input,
          warningsJson: JSON.stringify(input.warnings),
          tagsJson: JSON.stringify([]),
          hasMhtml: input.hasMhtml ? 1 : 0,
          hasScreenshot: input.hasScreenshot ? 1 : 0,
          hasText: input.hasText ? 1 : 0,
        });
      this.db
        .prepare('INSERT INTO archives_fts (archive_id, title, url, domain, body) VALUES (?, ?, ?, ?, ?)')
        .run(input.id, input.title, input.finalUrl, input.domain, '');
    });
    txn();
  }

  updateExtractedText(archiveId: string, body: string): void {
    this.db.prepare('UPDATE archives_fts SET body = ? WHERE archive_id = ?').run(body, archiveId);
  }

  markHasText(archiveId: string): void {
    this.db.prepare('UPDATE archives SET has_text = 1 WHERE id = ?').run(archiveId);
  }

  updateSize(archiveId: string, sizeBytes: number): void {
    this.db.prepare('UPDATE archives SET size_bytes = ? WHERE id = ?').run(sizeBytes, archiveId);
  }

  updateStatus(archiveId: string, status: ArchiveRecord['status'], warnings: CaptureWarning[]): void {
    this.db
      .prepare('UPDATE archives SET status = ?, warnings_json = ? WHERE id = ?')
      .run(status, JSON.stringify(warnings), archiveId);
  }

  getById(archiveId: string): ArchiveDetail | null {
    const row = this.db.prepare('SELECT * FROM archives WHERE id = ? AND deleted = 0').get(archiveId) as
      | ArchiveRow
      | undefined;
    if (!row) return null;
    const versionCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM archives WHERE canonical_url = ? AND deleted = 0')
        .get(row.canonical_url) as { c: number }
    ).c;
    return {
      ...rowToRecord(row),
      hasMhtml: row.has_mhtml === 1,
      hasScreenshot: row.has_screenshot === 1,
      hasText: row.has_text === 1,
      mhtmlSha256: row.mhtml_sha256,
      screenshotSha256: row.screenshot_sha256,
      textSha256: row.text_sha256,
      versionCount,
    };
  }

  getVersions(canonicalUrl: string): ArchiveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM archives WHERE canonical_url = ? AND deleted = 0 ORDER BY visited_at DESC')
      .all(canonicalUrl) as ArchiveRow[];
    return rows.map(rowToRecord);
  }

  findMostRecentByCanonicalUrl(canonicalUrl: string): ArchiveRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM archives WHERE canonical_url = ? AND deleted = 0 AND status = ? ORDER BY visited_at DESC LIMIT 1',
      )
      .get(canonicalUrl, 'success') as ArchiveRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  query(q: LibraryQuery): LibraryPage {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const clauses: string[] = ['a.deleted = 0'];
    const params: Record<string, unknown> = {};

    const isSearch = !!(q.search && q.search.trim().length > 0);
    let fromClause = 'FROM archives a';
    let snippetSelect = 'NULL as snippet';
    if (isSearch) {
      fromClause = 'FROM archives_fts f JOIN archives a ON a.id = f.archive_id';
      clauses.push('archives_fts MATCH @search');
      params.search = sanitizeFtsQuery(q.search!.trim());
      // -1 picks whichever indexed column (title/url/domain/body) the
      // match actually landed in, rather than assuming it's always the
      // body text. The marker characters are fixed constants (not user
      // input), so splicing them into the SQL text here is safe.
      snippetSelect = `snippet(archives_fts, -1, '${SNIPPET_MARK_START}', '${SNIPPET_MARK_END}', '…', 10) as snippet`;
    }
    if (q.domain) {
      clauses.push('a.domain = @domain');
      params.domain = q.domain;
    }
    if (q.status) {
      clauses.push('a.status = @status');
      params.status = q.status;
    }
    if (q.dateFrom) {
      clauses.push('a.visited_at >= @dateFrom');
      params.dateFrom = q.dateFrom;
    }
    if (q.dateTo) {
      clauses.push('a.visited_at <= @dateTo');
      params.dateTo = q.dateTo;
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // A search ranks by relevance (bm25 -- more negative is a better
    // match; title matches count double, since a term appearing in the
    // title is a stronger signal than the same term buried in body text)
    // rather than by the requested sort, which would otherwise silently
    // stop meaning what its label says the moment a search term is added.
    const orderBy = isSearch
      ? 'bm25(archives_fts, 0.0, 2.0, 1.0, 1.0, 1.0) ASC'
      : q.sort === 'oldest'
        ? 'a.visited_at ASC'
        : q.sort === 'domain'
          ? 'a.domain ASC, a.visited_at DESC'
          : q.sort === 'size'
            ? 'a.size_bytes DESC'
            : 'a.visited_at DESC';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as c ${fromClause} ${where}`).get(params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(`SELECT a.*, ${snippetSelect} ${fromClause} ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as (ArchiveRow & { snippet: string | null })[];

    const items: LibraryResultItem[] = rows.map((row) => ({ ...rowToRecord(row), snippet: row.snippet }));
    return { items, total };
  }

  rename(archiveId: string, title: string): void {
    this.db.prepare('UPDATE archives SET title = ? WHERE id = ?').run(title, archiveId);
    this.db.prepare('UPDATE archives_fts SET title = ? WHERE archive_id = ?').run(title, archiveId);
  }

  setTags(archiveId: string, tags: string[]): void {
    this.db.prepare('UPDATE archives SET tags_json = ? WHERE id = ?').run(JSON.stringify(tags), archiveId);
  }

  softDelete(archiveId: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE archives SET deleted = 1 WHERE id = ?').run(archiveId);
      this.db.prepare('DELETE FROM archives_fts WHERE archive_id = ?').run(archiveId);
    });
    txn();
  }

  listIdsByDomain(domain: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM archives WHERE domain = ? AND deleted = 0')
      .all(domain) as { id: string }[];
    return rows.map((r) => r.id);
  }

  listDistinctDomains(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT domain FROM archives WHERE deleted = 0 ORDER BY domain ASC')
      .all() as { domain: string }[];
    return rows.map((r) => r.domain);
  }

  totalSizeBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) as s FROM archives WHERE deleted = 0')
      .get() as { s: number };
    return row.s;
  }

  countActive(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM archives WHERE deleted = 0').get() as { c: number }).c;
  }

  /** Oldest-first, for retention-policy / storage-limit eviction. */
  listOldestActive(limit: number): ArchiveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM archives WHERE deleted = 0 ORDER BY visited_at ASC LIMIT ?')
      .all(limit) as ArchiveRow[];
    return rows.map(rowToRecord);
  }

  /** Every active archive's full row, for whole-library export (libraryTransfer.ts). */
  listAllForExport(): ArchiveExportEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM archives WHERE deleted = 0 ORDER BY visited_at ASC')
      .all() as ArchiveRow[];
    return rows.map((row) => ({
      id: row.id,
      canonicalUrl: row.canonical_url,
      originalUrl: row.original_url,
      finalUrl: row.final_url,
      title: row.title,
      domain: row.domain,
      // Never exported: an absolute path only meaningful on this machine.
      // Recomputed on import from whether a favicon file actually comes
      // along (hasFavicon below).
      faviconPath: null,
      referrerUrl: row.referrer_url,
      capturedAt: row.captured_at,
      visitedAt: row.visited_at,
      status: row.status,
      warnings: JSON.parse(row.warnings_json) as CaptureWarning[],
      sizeBytes: row.size_bytes,
      appVersion: row.app_version,
      schemaVersion: row.schema_version,
      hasMhtml: row.has_mhtml === 1,
      hasScreenshot: row.has_screenshot === 1,
      hasText: row.has_text === 1,
      mhtmlSha256: row.mhtml_sha256,
      screenshotSha256: row.screenshot_sha256,
      textSha256: row.text_sha256,
      tags: JSON.parse(row.tags_json) as string[],
      hasFavicon: row.favicon_path !== null,
    }));
  }

  /**
   * True if a row with this id exists at all, deleted or not -- `id` is
   * the primary key, so a whole-library import must check this (not just
   * the non-deleted view every other query uses) before inserting, or a
   * duplicate id collides with a soft-deleted row still occupying it.
   */
  existsAnyById(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM archives WHERE id = ?').get(id);
  }

  // --- crash recovery bookkeeping ---

  markCaptureStarted(archiveId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO interrupted_captures (archive_id, started_at) VALUES (?, ?)')
      .run(archiveId, new Date().toISOString());
  }

  markCaptureFinished(archiveId: string): void {
    this.db.prepare('DELETE FROM interrupted_captures WHERE archive_id = ?').run(archiveId);
  }

  listInterruptedCaptureIds(): string[] {
    const rows = this.db.prepare('SELECT archive_id FROM interrupted_captures').all() as { archive_id: string }[];
    return rows.map((r) => r.archive_id);
  }
}
