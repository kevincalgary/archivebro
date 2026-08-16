import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  ArchivedAssetEntry,
  ArchivedPageEntry,
  ArchivedResponseEntry,
  AssetKind,
  CaptureFailureEntry,
  RouteMapEntry,
  ScreenshotFallbackMeta,
  SiteArchiveManifest,
} from '../../shared/sitearchiveTypes';
import { SITEARCHIVE_FORMAT_VERSION } from '../../shared/sitearchiveTypes';
import { logger } from '../util/logger';

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'text/css': 'css',
  'text/html': 'html',
  'text/plain': 'txt',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
};

export function extensionForContentType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_CONTENT_TYPE[base] ?? 'bin';
}

export function assetKindForContentType(contentType: string): AssetKind {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('font/') || base.includes('font')) return 'font';
  if (base.startsWith('video/') || base.startsWith('audio/')) return 'media';
  if (base === 'text/css') return 'stylesheet';
  if (base === 'application/javascript' || base === 'text/javascript') return 'script';
  if (base === 'application/pdf' || base.startsWith('application/vnd.')) return 'document';
  return 'other';
}

/**
 * Accumulates the contents of one .sitearchive while a capture runs, then
 * writes the ZIP container.
 *
 * Everything is staged under a temp directory and the finished archive is
 * written to `<final>.tmp-<uuid>` before being renamed into place, so a
 * cancelled or crashed capture can never leave a half-written
 * .sitearchive where a valid one used to be (rename is atomic on the same
 * filesystem).
 */
export class SiteArchiveBuilder {
  private pages: ArchivedPageEntry[] = [];
  private assets = new Map<string, ArchivedAssetEntry>();
  private responses = new Map<string, ArchivedResponseEntry>();
  private routes = new Map<string, RouteMapEntry>();
  private failures: CaptureFailureEntry[] = [];
  private stagingDir: string | null = null;
  private totalUncompressed = 0;

  constructor(
    readonly archiveId: string,
    private readonly appVersion: string,
  ) {}

  async init(tmpRoot: string): Promise<void> {
    this.stagingDir = path.join(tmpRoot, `sitearchive-staging-${this.archiveId}`);
    await fs.rm(this.stagingDir, { recursive: true, force: true });
    await fs.mkdir(path.join(this.stagingDir, 'pages'), { recursive: true });
    await fs.mkdir(path.join(this.stagingDir, 'assets'), { recursive: true });
    await fs.mkdir(path.join(this.stagingDir, 'screenshots'), { recursive: true });
    await fs.mkdir(path.join(this.stagingDir, 'responses'), { recursive: true });
  }

  private requireStaging(): string {
    if (!this.stagingDir) throw new Error('SiteArchiveBuilder.init() was not called');
    return this.stagingDir;
  }

  get totalBytes(): number {
    return this.totalUncompressed;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get assetCount(): number {
    return this.assets.size;
  }

  hasPageForNormalizedUrl(normalizedUrl: string): boolean {
    return this.pages.some((p) => p.normalizedUrl === normalizedUrl);
  }

  /**
   * Store bytes as a content-addressed asset. Returns the archive-relative
   * path. Identical bytes used by many pages are stored exactly once --
   * the second call just appends to sourceUrls.
   */
  async addAsset(
    data: Buffer,
    contentType: string,
    sourceUrl: string | null,
    screenshotFallback?: ScreenshotFallbackMeta,
  ): Promise<ArchivedAssetEntry> {
    const hash = sha256(data);
    const existing = this.assets.get(hash);
    if (existing) {
      if (sourceUrl && !existing.sourceUrls.includes(sourceUrl)) existing.sourceUrls.push(sourceUrl);
      return existing;
    }

    const ext = extensionForContentType(contentType);
    const relPath = `assets/${hash}.${ext}`;
    await fs.writeFile(path.join(this.requireStaging(), relPath), data);
    this.totalUncompressed += data.length;

    const entry: ArchivedAssetEntry = {
      sha256: hash,
      path: relPath,
      contentType,
      byteSize: data.length,
      kind: assetKindForContentType(contentType),
      sourceUrls: sourceUrl ? [sourceUrl] : [],
      ...(screenshotFallback ? { screenshotFallback } : {}),
    };
    this.assets.set(hash, entry);
    return entry;
  }

  async addResponse(data: Buffer, url: string, normalizedUrl: string, contentType: string, status: number): Promise<ArchivedResponseEntry> {
    const hash = sha256(data);
    const existing = this.responses.get(hash);
    if (existing) return existing;

    const relPath = `responses/${hash}.json`;
    await fs.writeFile(path.join(this.requireStaging(), relPath), data);
    this.totalUncompressed += data.length;

    const entry: ArchivedResponseEntry = {
      sha256: hash,
      path: relPath,
      url,
      normalizedUrl,
      contentType,
      byteSize: data.length,
      method: 'GET',
      status,
    };
    this.responses.set(hash, entry);
    this.routes.set(normalizedUrl, { normalizedUrl, target: { type: 'response', sha256: hash } });
    return entry;
  }

  async addPage(input: {
    pageId: string;
    originalUrl: string;
    finalUrl: string;
    normalizedUrl: string;
    title: string;
    depth: number;
    html: string;
    screenshot: Buffer | null;
    text: string | null;
    redirectedFrom: string[];
  }): Promise<ArchivedPageEntry> {
    const staging = this.requireStaging();
    const htmlBuf = Buffer.from(input.html, 'utf8');
    const htmlPath = `pages/${input.pageId}.html`;
    await fs.writeFile(path.join(staging, htmlPath), htmlBuf);
    this.totalUncompressed += htmlBuf.length;

    let screenshotPath: string | null = null;
    let screenshotSha: string | null = null;
    if (input.screenshot) {
      screenshotPath = `screenshots/${input.pageId}.png`;
      await fs.writeFile(path.join(staging, screenshotPath), input.screenshot);
      screenshotSha = sha256(input.screenshot);
      this.totalUncompressed += input.screenshot.length;
    }

    let textPath: string | null = null;
    let textSha: string | null = null;
    if (input.text !== null) {
      const textBuf = Buffer.from(input.text, 'utf8');
      textPath = `pages/${input.pageId}.txt`;
      await fs.writeFile(path.join(staging, textPath), textBuf);
      textSha = sha256(textBuf);
      this.totalUncompressed += textBuf.length;
    }

    const entry: ArchivedPageEntry = {
      pageId: input.pageId,
      originalUrl: input.originalUrl,
      finalUrl: input.finalUrl,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      depth: input.depth,
      capturedAt: new Date().toISOString(),
      htmlPath,
      htmlSha256: sha256(htmlBuf),
      screenshotPath,
      screenshotSha256: screenshotSha,
      textPath,
      textSha256: textSha,
      redirectedFrom: input.redirectedFrom,
      contentType: 'text/html; charset=utf-8',
      byteSize: htmlBuf.length,
    };
    this.pages.push(entry);

    // Route the page's own URL, plus every URL that redirected to it, so
    // links to any point in the redirect chain resolve offline.
    this.routes.set(input.normalizedUrl, { normalizedUrl: input.normalizedUrl, target: { type: 'page', pageId: input.pageId } });
    for (const from of input.redirectedFrom) {
      this.routes.set(from, { normalizedUrl: from, target: { type: 'page', pageId: input.pageId } });
    }
    return entry;
  }

  /** Point a normalized URL at an already-stored asset (for rewritten links). */
  routeAsset(normalizedUrl: string, sha: string): void {
    this.routes.set(normalizedUrl, { normalizedUrl, target: { type: 'asset', sha256: sha } });
  }

  addFailure(failure: CaptureFailureEntry): void {
    // Keep the list bounded so a pathological crawl can't grow the
    // manifest without limit.
    if (this.failures.length < 5000) this.failures.push(failure);
  }

  get failureList(): CaptureFailureEntry[] {
    return this.failures;
  }

  /** Build the SQLite catalog that ships inside the container. */
  private async writeIndexDatabase(): Promise<{ buffer: Buffer; relPath: string }> {
    const staging = this.requireStaging();
    const dbPath = path.join(staging, 'index.sqlite');
    await fs.rm(dbPath, { force: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE pages (
          page_id TEXT PRIMARY KEY,
          original_url TEXT NOT NULL,
          final_url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT NOT NULL,
          depth INTEGER NOT NULL,
          html_path TEXT NOT NULL,
          screenshot_path TEXT,
          text_path TEXT
        );
        CREATE INDEX idx_pages_normalized ON pages(normalized_url);
        CREATE TABLE assets (
          sha256 TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          content_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          kind TEXT NOT NULL,
          is_screenshot_fallback INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE asset_urls (
          url TEXT NOT NULL,
          sha256 TEXT NOT NULL
        );
        CREATE INDEX idx_asset_urls_url ON asset_urls(url);
        CREATE TABLE routes (
          normalized_url TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL
        );
      `);

      const insertPage = db.prepare(
        'INSERT INTO pages (page_id, original_url, final_url, normalized_url, title, depth, html_path, screenshot_path, text_path) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const insertAsset = db.prepare(
        'INSERT INTO assets (sha256, path, content_type, byte_size, kind, is_screenshot_fallback) VALUES (?,?,?,?,?,?)',
      );
      const insertAssetUrl = db.prepare('INSERT INTO asset_urls (url, sha256) VALUES (?,?)');
      const insertRoute = db.prepare('INSERT OR REPLACE INTO routes (normalized_url, target_type, target_id) VALUES (?,?,?)');

      db.transaction(() => {
        for (const p of this.pages) {
          insertPage.run(p.pageId, p.originalUrl, p.finalUrl, p.normalizedUrl, p.title, p.depth, p.htmlPath, p.screenshotPath, p.textPath);
        }
        for (const a of this.assets.values()) {
          insertAsset.run(a.sha256, a.path, a.contentType, a.byteSize, a.kind, a.screenshotFallback ? 1 : 0);
          for (const url of a.sourceUrls) insertAssetUrl.run(url, a.sha256);
        }
        for (const r of this.routes.values()) {
          const targetId = r.target.type === 'page' ? r.target.pageId : r.target.sha256;
          insertRoute.run(r.normalizedUrl, r.target.type, targetId);
        }
      })();
    } finally {
      db.close();
    }

    const buffer = await fs.readFile(dbPath);
    this.totalUncompressed += buffer.length;
    return { buffer, relPath: 'index.sqlite' };
  }

  /**
   * Zip the staged contents to `finalPath`, atomically. Returns the
   * finished manifest.
   */
  async finalize(input: {
    finalPath: string;
    startUrl: string;
    startFinalUrl: string;
    siteTitle: string;
    scope: SiteArchiveManifest['scope'];
  }): Promise<{ manifest: SiteArchiveManifest; fileSizeBytes: number }> {
    const staging = this.requireStaging();
    const index = await this.writeIndexDatabase();

    const manifest: SiteArchiveManifest = {
      formatVersion: SITEARCHIVE_FORMAT_VERSION,
      archiveId: this.archiveId,
      startUrl: input.startUrl,
      startFinalUrl: input.startFinalUrl,
      siteTitle: input.siteTitle,
      capturedAt: new Date().toISOString(),
      scope: input.scope,
      pages: this.pages,
      assets: [...this.assets.values()],
      responses: [...this.responses.values()],
      routes: [...this.routes.values()],
      failures: this.failures,
      appVersion: this.appVersion,
      totalUncompressedBytes: this.totalUncompressed,
      indexPath: index.relPath,
      indexSha256: sha256(index.buffer),
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    await fs.writeFile(path.join(staging, 'manifest.json'), manifestJson, 'utf8');

    const tmpOut = `${input.finalPath}.tmp-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(input.finalPath), { recursive: true });

    try {
      await zipDirectory(staging, tmpOut);
      // Only now does the .sitearchive name start pointing at these bytes.
      await fs.rename(tmpOut, input.finalPath);
    } catch (err) {
      await fs.rm(tmpOut, { force: true }).catch(() => {});
      throw err;
    }

    const stat = await fs.stat(input.finalPath);
    logger.info('sitearchive.finalized', {
      archiveId: this.archiveId,
      pages: this.pages.length,
      assets: this.assets.size,
      bytes: stat.size,
    });
    return { manifest, fileSizeBytes: stat.size };
  }

  /** Remove staged data. Safe to call after success, failure, or cancel. */
  async cleanup(): Promise<void> {
    if (!this.stagingDir) return;
    await fs.rm(this.stagingDir, { recursive: true, force: true }).catch(() => {});
    this.stagingDir = null;
  }
}

function zipDirectory(sourceDir: string, destZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const { ZipArchive } = await import('archiver');
        const output = createWriteStream(destZipPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });
        output.on('close', () => resolve());
        output.on('error', (err: unknown) => reject(err));
        archive.on('error', (err: unknown) => reject(err));
        archive.pipe(output);
        archive.directory(sourceDir, false);
        void archive.finalize();
      } catch (err) {
        reject(err);
      }
    })();
  });
}
