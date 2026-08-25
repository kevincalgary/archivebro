import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/main/db/schema';
import { ArchiveRepo, type NewArchiveInput } from '../../src/main/db/archiveRepo';
import { archiveFilePaths } from '../../src/main/util/paths';
import { sha256Hex } from '../../src/main/util/hash';
import {
  exportLibrary,
  importLibrary,
  LibraryTransferError,
  LIBRARY_EXPORT_FORMAT_VERSION,
  type LibraryExportManifest,
} from '../../src/main/library/libraryTransfer';

let sourceRoot: string;
let destRoot: string;
let sourceDb: Database.Database;
let destDb: Database.Database;
let sourceRepo: ArchiveRepo;
let destRepo: ArchiveRepo;

beforeEach(async () => {
  sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-transfer-src-'));
  destRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-transfer-dst-'));
  sourceDb = new Database(':memory:');
  sourceDb.exec(SCHEMA_SQL);
  sourceRepo = new ArchiveRepo(sourceDb);
  destDb = new Database(':memory:');
  destDb.exec(SCHEMA_SQL);
  destRepo = new ArchiveRepo(destDb);
});

afterEach(async () => {
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.rm(destRoot, { recursive: true, force: true });
  sourceDb.close();
  destDb.close();
});

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
    sizeBytes: 0,
    appVersion: '0.1.0',
    schemaVersion: 1,
    hasMhtml: false,
    hasScreenshot: false,
    hasText: false,
    mhtmlSha256: null,
    screenshotSha256: null,
    textSha256: null,
    ...overrides,
  };
}

/** Writes a full archive's content files to disk and inserts its DB row, mirroring a real capture. */
async function seedArchive(
  repo: ArchiveRepo,
  root: string,
  overrides: Partial<NewArchiveInput> = {},
  content: { mhtml?: string; screenshot?: Buffer; text?: string; favicon?: Buffer } = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const paths = archiveFilePaths(root, id);
  await fs.mkdir(paths.dir, { recursive: true });

  const mhtml = content.mhtml ?? '<html><body>Hello</body></html>';
  const screenshot = content.screenshot ?? Buffer.from('fake-png-bytes');
  const text = content.text ?? 'Hello extracted text';

  await fs.writeFile(paths.mhtml, mhtml);
  await fs.writeFile(paths.screenshot, screenshot);
  await fs.writeFile(paths.text, text);
  let hasFavicon = false;
  if (content.favicon) {
    await fs.writeFile(paths.favicon, content.favicon);
    hasFavicon = true;
  }

  const input = makeInput({
    id,
    hasMhtml: true,
    hasScreenshot: true,
    hasText: true,
    mhtmlSha256: sha256Hex(mhtml),
    screenshotSha256: sha256Hex(screenshot),
    textSha256: sha256Hex(text),
    faviconPath: hasFavicon ? paths.favicon : null,
    ...overrides,
  });
  repo.insert(input);
  repo.updateExtractedText(id, text);
  return id;
}

/** Builds a custom export zip directly (bypassing exportLibrary), for exercising malformed/hostile inputs. */
async function writeCustomZip(destZipPath: string, manifest: unknown, files: { name: string; content: Buffer | string }[]) {
  const { ZipArchive } = await import('archiver');
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    output.on('error', reject);
    archive.pipe(output);
    for (const f of files) archive.append(f.content, { name: f.name });
    if (manifest !== undefined) archive.append(JSON.stringify(manifest), { name: 'library-manifest.json' });
    void archive.finalize();
  });
}

describe('exportLibrary / importLibrary round trip', () => {
  it('carries an archive\'s files, catalog row, tags, and searchable text to a fresh library', async () => {
    const id = await seedArchive(sourceRepo, sourceRoot, { title: 'Widget Catalog', domain: 'widgets.example' });
    sourceRepo.setTags(id, ['reference', 'work']);

    const zipPath = path.join(sourceRoot, 'export.zip');
    const { archiveCount } = await exportLibrary(sourceRoot, sourceRepo, zipPath, '0.1.0');
    expect(archiveCount).toBe(1);

    const result = await importLibrary(zipPath, destRoot, destRepo);
    expect(result).toEqual({ importedCount: 1, skippedCount: 0, failedCount: 0 });

    const detail = destRepo.getById(id);
    expect(detail?.title).toBe('Widget Catalog');
    expect(detail?.domain).toBe('widgets.example');
    expect(detail?.tags).toEqual(['reference', 'work']);
    expect(detail?.hasMhtml).toBe(true);

    const paths = archiveFilePaths(destRoot, id);
    expect((await fs.readFile(paths.mhtml, 'utf8'))).toBe('<html><body>Hello</body></html>');
    expect((await fs.readFile(paths.text, 'utf8'))).toBe('Hello extracted text');

    // Extracted text must be re-indexed into FTS on the destination, not
    // just written to disk -- search is how a migrated library actually
    // gets used.
    expect(destRepo.query({ search: 'extracted' }).total).toBe(1);
  });

  it('recomputes faviconPath rather than trusting the exported absolute path, and omits it when no favicon was captured', async () => {
    const withFavicon = await seedArchive(sourceRepo, sourceRoot, {}, { favicon: Buffer.from('favicon-bytes') });
    const withoutFavicon = await seedArchive(sourceRepo, sourceRoot, {
      canonicalUrl: 'https://example.com/other',
      finalUrl: 'https://example.com/other',
    });

    const zipPath = path.join(sourceRoot, 'export.zip');
    await exportLibrary(sourceRoot, sourceRepo, zipPath, '0.1.0');
    await importLibrary(zipPath, destRoot, destRepo);

    const faviconPaths = archiveFilePaths(destRoot, withFavicon);
    expect(destRepo.getById(withFavicon)?.faviconPath).toBe(faviconPaths.favicon);
    expect(await fs.readFile(faviconPaths.favicon)).toEqual(Buffer.from('favicon-bytes'));
    expect(destRepo.getById(withoutFavicon)?.faviconPath).toBeNull();
  });

  it('skips an archive whose id already exists at the destination, even if it was soft-deleted there', async () => {
    const id = await seedArchive(sourceRepo, sourceRoot);
    const zipPath = path.join(sourceRoot, 'export.zip');
    await exportLibrary(sourceRoot, sourceRepo, zipPath, '0.1.0');

    // Simulate the destination already having (and having deleted) this
    // same archive -- id is a primary key, so re-inserting it must never
    // be attempted even when the existing row is soft-deleted.
    await seedArchive(destRepo, destRoot, { id });
    destRepo.softDelete(id);

    const result = await importLibrary(zipPath, destRoot, destRepo);
    expect(result).toEqual({ importedCount: 0, skippedCount: 1, failedCount: 0 });
  });

  it('a DB row whose file was deleted from disk is exported (and re-imported) without that file', async () => {
    const id = await seedArchive(sourceRepo, sourceRoot);
    // The DB still says hasMhtml, but the actual bytes are gone -- e.g. a
    // user manually deleted a file, or disk corruption. Export must not
    // promise content it can't actually find on disk right now.
    await fs.rm(archiveFilePaths(sourceRoot, id).mhtml);

    const zipPath = path.join(sourceRoot, 'export.zip');
    await exportLibrary(sourceRoot, sourceRepo, zipPath, '0.1.0');
    const result = await importLibrary(zipPath, destRoot, destRepo);

    expect(result.importedCount).toBe(1);
    expect(destRepo.getById(id)?.hasMhtml).toBe(false);
    expect(destRepo.getById(id)?.hasScreenshot).toBe(true);
  });
});

describe('importLibrary rejects hostile or malformed input', () => {
  it('rejects a zip with no library-manifest.json', async () => {
    const zipPath = path.join(sourceRoot, 'no-manifest.zip');
    await writeCustomZip(zipPath, undefined, [{ name: 'archives/x/page.mhtml', content: 'x' }]);

    await expect(importLibrary(zipPath, destRoot, destRepo)).rejects.toMatchObject({
      code: 'missing-manifest',
    });
  });

  it('rejects an export from a newer, unsupported format version', async () => {
    const manifest: LibraryExportManifest = {
      formatVersion: LIBRARY_EXPORT_FORMAT_VERSION + 1,
      appVersion: '99.0.0',
      exportedAt: new Date().toISOString(),
      archives: [],
    };
    const zipPath = path.join(sourceRoot, 'future.zip');
    await writeCustomZip(zipPath, manifest, []);

    await expect(importLibrary(zipPath, destRoot, destRepo)).rejects.toMatchObject({
      code: 'unsupported-version',
    });
  });

  it('skips a malformed archive entry (failedCount) rather than throwing, and still imports the valid ones', async () => {
    const goodId = crypto.randomUUID();
    const manifest = {
      formatVersion: LIBRARY_EXPORT_FORMAT_VERSION,
      appVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      archives: [
        // status is not one of the known values -- must be rejected, not crash the import.
        { id: crypto.randomUUID(), canonicalUrl: 'x', originalUrl: 'x', finalUrl: 'x', title: 't', domain: 'd', referrerUrl: null, capturedAt: 'x', visitedAt: 'x', status: 'bogus-status', warnings: [], sizeBytes: 0, appVersion: '0.1.0', schemaVersion: 1, tags: [], hasMhtml: false, hasScreenshot: false, hasText: false, hasFavicon: false, mhtmlSha256: null, screenshotSha256: null, textSha256: null },
        { id: goodId, canonicalUrl: 'https://good.example/', originalUrl: 'https://good.example/', finalUrl: 'https://good.example/', title: 'Good', domain: 'good.example', referrerUrl: null, capturedAt: new Date().toISOString(), visitedAt: new Date().toISOString(), status: 'success', warnings: [], sizeBytes: 0, appVersion: '0.1.0', schemaVersion: 1, tags: [], hasMhtml: false, hasScreenshot: false, hasText: false, hasFavicon: false, mhtmlSha256: null, screenshotSha256: null, textSha256: null },
      ],
    };
    const zipPath = path.join(sourceRoot, 'partial-bad.zip');
    await writeCustomZip(zipPath, manifest, []);

    const result = await importLibrary(zipPath, destRoot, destRepo);
    expect(result).toEqual({ importedCount: 1, skippedCount: 0, failedCount: 1 });
    expect(destRepo.getById(goodId)?.title).toBe('Good');
  });

  it('drops (rather than trusts) a content file whose bytes do not match the manifest checksum', async () => {
    const id = crypto.randomUUID();
    const realBytes = 'real mhtml content';
    const manifest = {
      formatVersion: LIBRARY_EXPORT_FORMAT_VERSION,
      appVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      archives: [
        {
          id,
          canonicalUrl: 'https://tampered.example/',
          originalUrl: 'https://tampered.example/',
          finalUrl: 'https://tampered.example/',
          title: 'Tampered',
          domain: 'tampered.example',
          referrerUrl: null,
          capturedAt: new Date().toISOString(),
          visitedAt: new Date().toISOString(),
          status: 'success',
          warnings: [],
          sizeBytes: 0,
          appVersion: '0.1.0',
          schemaVersion: 1,
          tags: [],
          hasMhtml: true,
          hasScreenshot: false,
          hasText: false,
          hasFavicon: false,
          // Declares a hash for content that isn't what's actually zipped below.
          mhtmlSha256: sha256Hex(realBytes),
          screenshotSha256: null,
          textSha256: null,
        },
      ],
    };
    const zipPath = path.join(sourceRoot, 'tampered.zip');
    await writeCustomZip(zipPath, manifest, [
      { name: `archives/${id}/page.mhtml`, content: 'this is NOT the content the hash above describes' },
    ]);

    const result = await importLibrary(zipPath, destRoot, destRepo);
    expect(result).toEqual({ importedCount: 1, skippedCount: 0, failedCount: 0 });

    const detail = destRepo.getById(id)!;
    expect(detail.hasMhtml).toBe(false);
    expect(detail.warnings.some((w) => w.code === 'import-content-missing')).toBe(true);
    await expect(fs.stat(archiveFilePaths(destRoot, id).mhtml)).rejects.toThrow();
  });
});
