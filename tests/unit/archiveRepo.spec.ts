import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/main/db/schema';
import { ArchiveRepo, type NewArchiveInput } from '../../src/main/db/archiveRepo';

function makeInput(overrides: Partial<NewArchiveInput> = {}): NewArchiveInput {
  return {
    id: crypto.randomUUID(),
    canonicalUrl: 'https://example.com/page',
    originalUrl: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    title: 'Example Page',
    domain: 'example.com',
    faviconPath: null,
    referrerUrl: null,
    capturedAt: new Date().toISOString(),
    visitedAt: new Date().toISOString(),
    status: 'success',
    warnings: [],
    sizeBytes: 1000,
    appVersion: '0.1.0',
    schemaVersion: 1,
    hasMhtml: true,
    hasScreenshot: true,
    hasText: true,
    mhtmlSha256: null,
    screenshotSha256: null,
    textSha256: null,
    ...overrides,
  };
}

let db: Database.Database;
let repo: ArchiveRepo;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  repo = new ArchiveRepo(db);
});

describe('ArchiveRepo', () => {
  it('inserts and retrieves an archive by id', () => {
    const input = makeInput();
    repo.insert(input);
    const detail = repo.getById(input.id);
    expect(detail?.title).toBe('Example Page');
    expect(detail?.versionCount).toBe(1);
  });

  it('round-trips per-file capture-time SHA-256 hashes, and tolerates null for pre-existing rows', () => {
    const withHashes = makeInput({
      mhtmlSha256: 'a'.repeat(64),
      screenshotSha256: 'b'.repeat(64),
      textSha256: 'c'.repeat(64),
    });
    repo.insert(withHashes);
    const detail = repo.getById(withHashes.id);
    expect(detail?.mhtmlSha256).toBe('a'.repeat(64));
    expect(detail?.screenshotSha256).toBe('b'.repeat(64));
    expect(detail?.textSha256).toBe('c'.repeat(64));

    const withoutHashes = makeInput({ canonicalUrl: 'https://example.com/older', finalUrl: 'https://example.com/older' });
    repo.insert(withoutHashes);
    const olderDetail = repo.getById(withoutHashes.id);
    expect(olderDetail?.mhtmlSha256).toBeNull();
    expect(olderDetail?.screenshotSha256).toBeNull();
    expect(olderDetail?.textSha256).toBeNull();
  });

  it('re-visiting the same canonical URL creates a new version, not an overwrite', () => {
    const first = makeInput({ visitedAt: '2026-01-01T00:00:00.000Z' });
    const second = makeInput({ visitedAt: '2026-01-02T00:00:00.000Z' });
    repo.insert(first);
    repo.insert(second);

    const versions = repo.getVersions('https://example.com/page');
    expect(versions.length).toBe(2);
    expect(versions.map((v) => v.id).sort()).toEqual([first.id, second.id].sort());
    expect(repo.getById(first.id)?.versionCount).toBe(2);
  });

  it('query() filters by domain, status, and date range', () => {
    repo.insert(makeInput({ domain: 'a.com', canonicalUrl: 'https://a.com/', finalUrl: 'https://a.com/', visitedAt: '2026-01-01T00:00:00.000Z' }));
    repo.insert(makeInput({ domain: 'b.com', canonicalUrl: 'https://b.com/', finalUrl: 'https://b.com/', status: 'failed', visitedAt: '2026-01-05T00:00:00.000Z' }));

    expect(repo.query({ domain: 'a.com' }).total).toBe(1);
    expect(repo.query({ status: 'failed' }).total).toBe(1);
    expect(repo.query({ dateFrom: '2026-01-03T00:00:00.000Z' }).total).toBe(1);
  });

  it('query() full-text search matches title and extracted text', () => {
    const input = makeInput({ title: 'Unique Widget Catalog' });
    repo.insert(input);
    repo.updateExtractedText(input.id, 'a very specific phrase appears only here');

    expect(repo.query({ search: 'Widget' }).total).toBe(1);
    expect(repo.query({ search: 'specific phrase' }).total).toBe(1);
    expect(repo.query({ search: 'nonexistent-term-xyz' }).total).toBe(0);
  });

  it('softDelete removes the archive from queries and from the search index', () => {
    const input = makeInput();
    repo.insert(input);
    repo.softDelete(input.id);

    expect(repo.getById(input.id)).toBeNull();
    expect(repo.query({}).items.some((i) => i.id === input.id)).toBe(false);
    expect(repo.query({ search: input.title }).total).toBe(0);
  });

  it('listIdsByDomain only returns active (non-deleted) archives', () => {
    const a = makeInput({ domain: 'evict.com', canonicalUrl: 'https://evict.com/a', finalUrl: 'https://evict.com/a' });
    const b = makeInput({ domain: 'evict.com', canonicalUrl: 'https://evict.com/b', finalUrl: 'https://evict.com/b' });
    repo.insert(a);
    repo.insert(b);
    repo.softDelete(a.id);

    expect(repo.listIdsByDomain('evict.com')).toEqual([b.id]);
  });

  it('interrupted-capture bookkeeping: markCaptureStarted / listInterruptedCaptureIds / markCaptureFinished', () => {
    const id = crypto.randomUUID();
    repo.markCaptureStarted(id);
    expect(repo.listInterruptedCaptureIds()).toContain(id);
    repo.markCaptureFinished(id);
    expect(repo.listInterruptedCaptureIds()).not.toContain(id);
  });

  it('totalSizeBytes and countActive ignore deleted archives', () => {
    const a = makeInput({ sizeBytes: 500 });
    const b = makeInput({ sizeBytes: 700, canonicalUrl: 'https://example.com/other', finalUrl: 'https://example.com/other' });
    repo.insert(a);
    repo.insert(b);
    expect(repo.totalSizeBytes()).toBe(1200);
    expect(repo.countActive()).toBe(2);

    repo.softDelete(a.id);
    expect(repo.totalSizeBytes()).toBe(700);
    expect(repo.countActive()).toBe(1);
  });
});
