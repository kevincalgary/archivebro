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
  CaptureScopeKind,
  ForumCaptureSummary,
  ForumPostEntry,
  RecoverableCaptureSummary,
  RouteMapEntry,
  ScreenshotFallbackMeta,
  SiteArchiveManifest,
} from '../../shared/sitearchiveTypes';
import { SITEARCHIVE_FORMAT_VERSION } from '../../shared/sitearchiveTypes';
import { logger } from '../util/logger';
import { writeWithEnospcRetry } from '../capture/diskSpace';
import { hostOf } from './urlNormalize';
import {
  CHECKPOINT_JOURNAL_FILE,
  CHECKPOINT_LOCK_FILE,
  CHECKPOINT_META_FILE,
  isStagingDirLive,
  readCheckpointMeta,
  replayCheckpoint,
  type CaptureCheckpointMeta,
  type CaptureJournal,
  type ReplayedCheckpoint,
} from './captureJournal';

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const STAGING_PREFIX = 'sitearchive-staging-';

/** Ceiling on the manifest's failure list. */
const MAX_FAILURES = 5000;
/** Per-kind ceiling for skips, so they can't crowd out real failures. */
const MAX_FAILURES_PER_SKIP_KIND = 500;

/** Recovery scaffolding that lives in the staging tree but never ships. */
const CHECKPOINT_FILES: ReadonlySet<string> = new Set([CHECKPOINT_META_FILE, CHECKPOINT_JOURNAL_FILE, CHECKPOINT_LOCK_FILE]);

/**
 * Don't touch a staging tree that has been written to recently -- it may
 * belong to a capture running right now in another instance (the e2e
 * suite launches the real app, and `app.getPath('temp')` is shared with
 * whatever the user already has open).
 */
const STAGING_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * How long a *recoverable* staging tree is kept.
 *
 * These hold real captured work that the user can still finish or resume,
 * so they are not ordinary garbage -- but they can be gigabytes, so they
 * don't get to live forever either.
 */
const RECOVERABLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoverableCapture {
  stagingDir: string;
  meta: CaptureCheckpointMeta;
  /** Newest write anywhere in the tree -- when the capture actually died. */
  lastWriteMs: number;
  bytesOnDisk: number;
}

/**
 * Staging trees from interrupted captures that still hold recoverable work.
 *
 * Ordered newest-first, so the most recently interrupted capture -- the one
 * a user is most likely asking about -- comes first.
 */
export async function listRecoverableCaptures(tmpRoot: string): Promise<RecoverableCapture[]> {
  const found: RecoverableCapture[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(tmpRoot);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const dir = path.join(tmpRoot, entry);
    try {
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const meta = await readCheckpointMeta(dir);
      if (!meta) continue;
      // A capture actively running right now -- possibly in another app
      // instance sharing this OS temp directory -- must never be offered
      // as "recoverable": finalizing or resuming it here would race with
      // that instance's live journal appends and staged-file writes.
      if (await isStagingDirLive(dir)) continue;
      found.push({
        stagingDir: dir,
        meta,
        lastWriteMs: await newestMtimeMs(dir),
        bytesOnDisk: await directorySize(dir),
      });
    } catch {
      // Unreadable directory: not recoverable, leave it to the sweep.
    }
  }

  return found.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
}

/**
 * `listRecoverableCaptures()`, enriched with journal-replay data for
 * display -- pages/failures counted so far, and whether there is anything
 * to finish. This is the only recovery listing the UI ever sees; it does
 * not duplicate the detection or liveness logic above, just replays each
 * candidate's journal for numbers to show.
 */
export async function listRecoverableCapturesSummary(tmpRoot: string): Promise<RecoverableCaptureSummary[]> {
  const found = await listRecoverableCaptures(tmpRoot);
  const summaries: RecoverableCaptureSummary[] = [];

  for (const r of found) {
    const checkpoint = await replayCheckpoint(r.stagingDir);
    // Corrupt or unreadable since listRecoverableCaptures found it (raced
    // with a delete, or a truncated sidecar): nothing safe to offer for it.
    if (!checkpoint) continue;

    summaries.push({
      archiveId: r.meta.archiveId,
      startUrl: r.meta.startUrl,
      outputPath: r.meta.outputPath,
      scopeKind: r.meta.scope.kind,
      startedAt: r.meta.startedAt,
      lastActivityMs: r.lastWriteMs,
      bytesOnDisk: r.bytesOnDisk,
      pagesCompleted: checkpoint.pagesCompleted,
      pagesDiscovered: checkpoint.pagesDiscovered,
      failureCount: checkpoint.failures.length,
      // Finishing with zero pages would produce an archive that fails to
      // open (openSiteArchive/openArchiveIntoTab reject an entry-less
      // archive as 'empty-archive'), so it must not be offered as valid.
      canFinish: checkpoint.pagesCompleted > 0,
    });
  }

  return summaries;
}

/**
 * Turn an interrupted capture into a valid `.sitearchive` covering the
 * pages it did manage to capture, without crawling any further.
 *
 * This is the "I don't want to redo two and a half hours, just give me
 * what you got" path. The result is a complete, checksum-consistent
 * container -- it simply holds fewer pages than the crawl intended, and
 * its failure list records that it stopped early.
 */
export async function finalizeRecoveredCapture(
  stagingDir: string,
  appVersion: string,
): Promise<{
  archivePath: string;
  pageCount: number;
  assetCount: number;
  fileSizeBytes: number;
  failures: CaptureFailureEntry[];
  siteTitle: string;
  startUrl: string;
  scopeKind: CaptureScopeKind;
} | null> {
  // Refuses to finalize a capture that is genuinely still being written to
  // elsewhere -- same reasoning as the guard in CaptureManager.resumeInterrupted.
  if (await isStagingDirLive(stagingDir)) return null;

  const checkpoint = await replayCheckpoint(stagingDir);
  if (!checkpoint) return null;

  const builder = new SiteArchiveBuilder(checkpoint.meta.archiveId, appVersion);
  await builder.initForResume(stagingDir);
  builder.restore(checkpoint);

  if (checkpoint.queue.length > 0) {
    // Say so inside the archive rather than letting it look complete.
    await builder.addFailure({
      url: checkpoint.meta.startUrl,
      kind: 'cancelled',
      message: `Capture was interrupted before finishing; ${checkpoint.queue.length} discovered page(s) were never captured.`,
      discoveredOn: null,
    });
  }

  const siteTitle = checkpoint.siteTitle || hostOf(checkpoint.meta.startUrl) || 'website';
  const { fileSizeBytes } = await builder.finalize({
    finalPath: checkpoint.meta.outputPath,
    startUrl: checkpoint.meta.startUrl,
    startFinalUrl: checkpoint.meta.startUrl,
    siteTitle,
    scope: checkpoint.meta.scope,
  });

  const pageCount = builder.pageCount;
  const assetCount = builder.assetCount;
  const failures = builder.failureList;
  await builder.cleanup();

  logger.info('sitearchive.recovered_partial', {
    archiveId: checkpoint.meta.archiveId,
    pages: pageCount,
    neverCaptured: checkpoint.queue.length,
  });

  return {
    archivePath: checkpoint.meta.outputPath,
    pageCount,
    assetCount,
    fileSizeBytes,
    failures,
    siteTitle,
    startUrl: checkpoint.meta.startUrl,
    scopeKind: checkpoint.meta.scope.kind,
  };
}

/**
 * Discard an interrupted capture and everything it staged.
 *
 * Returns false, without deleting anything, if the staging dir's capture
 * is still genuinely running elsewhere -- deleting out from under a live
 * journal would corrupt an in-progress capture, not just an idle one.
 * Returns true for a staging dir that is already gone, since "discard
 * something that doesn't exist" is a no-op success, not a failure.
 */
export async function discardRecoveredCapture(stagingDir: string): Promise<boolean> {
  if (await isStagingDirLive(stagingDir)) return false;
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * Remove staging trees left behind by captures that never finished.
 *
 * `cleanup()` runs in a `finally`, so an ordinary failure or cancel tidies
 * up after itself -- but a killed process (OOM, power loss, force quit)
 * never gets there, and the staging tree for a large crawl is gigabytes.
 * Nothing else ever deletes it, so without this it stays in the OS temp
 * directory permanently. The Library has the equivalent protection for its
 * own `.tmp-*` directories in `util/atomicWrite.ts`.
 */
export async function sweepSiteArchiveStaging(
  tmpRoot: string,
  now = Date.now(),
): Promise<{ removed: string[]; bytesFreed: number }> {
  const removed: string[] = [];
  let bytesFreed = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(tmpRoot);
  } catch {
    return { removed, bytesFreed };
  }

  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const dir = path.join(tmpRoot, entry);

    try {
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const idleMs = now - (await newestMtimeMs(dir));
      if (idleMs < STAGING_STALE_AFTER_MS) continue;

      // A checkpointed tree is recoverable work, not garbage: the user can
      // still finish it into a partial archive or resume the crawl. Give
      // it a long grace period rather than the ordinary one, so the fix
      // for leaked staging directories can't quietly delete a crawl that
      // died overnight.
      if (idleMs < RECOVERABLE_RETENTION_MS && (await readCheckpointMeta(dir)) !== null) continue;

      const size = await directorySize(dir);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(entry);
      bytesFreed += size;
    } catch {
      // A dir that vanished or can't be read is not worth failing startup.
    }
  }

  if (removed.length > 0) {
    logger.info('sitearchive.swept_staging', { count: removed.length, bytesFreed });
  }
  return { removed, bytesFreed };
}

/**
 * Newest mtime of the staging dir or any of its immediate children.
 *
 * The directory's own mtime is not enough: a running capture writes into
 * `assets/`, `pages/` and friends, which never touches the parent's mtime,
 * so a long crawl would look untouched and be eligible for deletion.
 */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  try {
    newest = (await fs.stat(dir)).mtimeMs;
    for (const child of await fs.readdir(dir)) {
      try {
        newest = Math.max(newest, (await fs.stat(path.join(dir, child))).mtimeMs);
      } catch {
        /* raced with a delete */
      }
    }
  } catch {
    /* fall back to whatever we have */
  }
  return newest;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const stat = await fs.stat(full);
      total += stat.isDirectory() ? await directorySize(full) : stat.size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
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
  private pageNormalizedUrls = new Set<string>();
  private assets = new Map<string, ArchivedAssetEntry>();
  private responses = new Map<string, ArchivedResponseEntry>();
  private routes = new Map<string, RouteMapEntry>();
  private forumPosts: ForumPostEntry[] = [];
  /**
   * Real forum markup isn't always well-formed -- a post's container and
   * an inner anchor can both carry the same id="post-<n>" (seen on real
   * vBulletin pages), so DETECT_FORUM_POSTS_SCRIPT can report the same
   * anchor twice for one page. Without this, the second addForumPost()
   * call inserted a duplicate primary key at finalize time, which threw
   * out of writeIndexDatabase()'s transaction and discarded the *entire*
   * capture -- pages and assets that had already succeeded included, not
   * just the mis-indexed post.
   */
  private seenForumPostIds = new Set<string>();
  private failures: CaptureFailureEntry[] = [];
  private failureCountsByKind = new Map<string, number>();
  private stagingDir: string | null = null;
  private totalUncompressed = 0;
  private journal: CaptureJournal | null = null;
  /**
   * Content hash -> in-progress write, for addAsset/addResponse.
   *
   * Now that pages are captured in parallel (see crawler.ts), two workers
   * can genuinely race to store the identical bytes at the same time (a
   * shared logo referenced from two different pages fetched concurrently)
   * -- without this, both would see `this.assets.get(hash)` miss, both
   * `await fs.writeFile()` the same path concurrently (a real risk of a
   * torn write for a large asset split across multiple write() syscalls),
   * and one caller's sourceUrl could be silently lost since neither took
   * the "existing" branch. A second caller for the same hash instead awaits
   * the first caller's write and only then records its sourceUrl against
   * the one entry that actually got created.
   */
  private assetWritesInFlight = new Map<string, Promise<ArchivedAssetEntry>>();
  private responseWritesInFlight = new Map<string, Promise<ArchivedResponseEntry>>();

  constructor(
    readonly archiveId: string,
    private readonly appVersion: string,
  ) {}

  static stagingDirFor(tmpRoot: string, archiveId: string): string {
    return path.join(tmpRoot, `${STAGING_PREFIX}${archiveId}`);
  }

  async init(tmpRoot: string): Promise<void> {
    this.stagingDir = SiteArchiveBuilder.stagingDirFor(tmpRoot, this.archiveId);
    await fs.rm(this.stagingDir, { recursive: true, force: true });
    await this.ensureStagingLayout();
  }

  /**
   * Adopt an existing staging tree from an interrupted capture.
   *
   * Deliberately does not wipe anything: the whole point is that the bytes
   * captured before the crash are still there and only the bookkeeping
   * needs rebuilding, via `restore()`.
   */
  async initForResume(stagingDir: string): Promise<void> {
    this.stagingDir = stagingDir;
    await this.ensureStagingLayout();
  }

  private async ensureStagingLayout(): Promise<void> {
    const staging = this.requireStaging();
    for (const sub of ['pages', 'assets', 'screenshots', 'responses', 'posts']) {
      await fs.mkdir(path.join(staging, sub), { recursive: true });
    }
  }

  get stagingPath(): string | null {
    return this.stagingDir;
  }

  setJournal(journal: CaptureJournal | null): void {
    this.journal = journal;
  }

  /** Rehydrate from a replayed journal, before the crawl continues. */
  restore(checkpoint: ReplayedCheckpoint): void {
    this.pages = checkpoint.pages;
    this.pageNormalizedUrls = new Set(checkpoint.pages.map((p) => p.normalizedUrl));
    this.assets = checkpoint.assets;
    this.responses = checkpoint.responses;
    this.routes = checkpoint.routes;
    this.forumPosts = checkpoint.forumPosts ?? [];
    this.seenForumPostIds = new Set(this.forumPosts.map((p) => p.postId));
    this.failures = checkpoint.failures;
    this.failureCountsByKind = new Map();
    for (const f of checkpoint.failures) {
      this.failureCountsByKind.set(f.kind, (this.failureCountsByKind.get(f.kind) ?? 0) + 1);
    }
    this.totalUncompressed = checkpoint.totalUncompressed;
  }

  /**
   * Rehydrate from an already-finalized .sitearchive's manifest, for
   * retryFailedPages.ts. Unlike restore() (mid-crawl, from a journal),
   * this seeds a builder with a *complete, already-zipped* archive's
   * contents so only the previously-failed pages need to be attempted
   * again -- everything else is kept exactly as it was.
   *
   * `retryingUrls` are excluded from the restored failure list: a
   * successful retry never re-adds them, and a still-failing retry adds
   * its own fresh failure entry, so keeping the old one around would just
   * leave a stale duplicate.
   */
  restoreFromManifest(manifest: SiteArchiveManifest, retryingUrls: ReadonlySet<string>): void {
    this.pages = [...manifest.pages];
    this.pageNormalizedUrls = new Set(manifest.pages.map((p) => p.normalizedUrl));
    this.assets = new Map(manifest.assets.map((a) => [a.sha256, a]));
    this.responses = new Map(manifest.responses.map((r) => [r.sha256, r]));
    this.routes = new Map(manifest.routes.map((r) => [r.normalizedUrl, r]));
    // Posts belonging to a page being retried are dropped -- a successful
    // retry re-extracts them fresh (capturePostsForIndex runs again for
    // that page); a still-failing retry has no page to extract from at
    // all. copyExistingEntriesIntoStaging (retryFailedPages.ts) carries
    // the corresponding posts/<id>.txt bodies over for everything kept.
    const retriedPageIds = new Set(
      manifest.pages.filter((p) => retryingUrls.has(p.normalizedUrl)).map((p) => p.pageId),
    );
    this.forumPosts = (manifest.forumPosts ?? []).filter((post) => !retriedPageIds.has(post.pageId));
    this.seenForumPostIds = new Set(this.forumPosts.map((p) => p.postId));
    this.failures = manifest.failures.filter((f) => !retryingUrls.has(f.url));
    this.failureCountsByKind = new Map();
    for (const f of this.failures) {
      this.failureCountsByKind.set(f.kind, (this.failureCountsByKind.get(f.kind) ?? 0) + 1);
    }
    // Bytes already on disk for the content being carried over unchanged --
    // copyExistingEntriesIntoStaging() (retryFailedPages.ts) writes those
    // same bytes into the new staging tree directly, not through
    // addPage()/addAsset(), so this is the one place that accounts for
    // them. Only genuinely new bytes from a successful retry add on top,
    // through the normal addPage()/addAsset() codepath.
    this.totalUncompressed = manifest.totalUncompressedBytes;
  }

  private requireStaging(): string {
    if (!this.stagingDir) throw new Error('SiteArchiveBuilder.init() was not called');
    return this.stagingDir;
  }

  /** Set a route and record it, so the route map survives a crash. */
  private async setRoute(entry: RouteMapEntry): Promise<void> {
    this.routes.set(entry.normalizedUrl, entry);
    await this.journal?.append({ t: 'route', e: entry });
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
    // Set lookup rather than scanning `pages`: this is called once per
    // captured page, so a linear scan would be O(n^2) over the whole
    // crawl -- which matters now that captures can be unlimited.
    return this.pageNormalizedUrls.has(normalizedUrl);
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

    const recordSourceUrl = async (entry: ArchivedAssetEntry) => {
      if (sourceUrl && !entry.sourceUrls.includes(sourceUrl)) {
        entry.sourceUrls.push(sourceUrl);
        await this.journal?.append({ t: 'assetUrl', sha: hash, url: sourceUrl });
      }
      return entry;
    };

    const existing = this.assets.get(hash);
    if (existing) return recordSourceUrl(existing);

    // A second concurrent caller for this exact hash awaits the same
    // write rather than starting its own -- see the field doc above.
    const inFlight = this.assetWritesInFlight.get(hash);
    if (inFlight) return recordSourceUrl(await inFlight);

    const writePromise = (async (): Promise<ArchivedAssetEntry> => {
      const ext = extensionForContentType(contentType);
      const relPath = `assets/${hash}.${ext}`;
      await writeWithEnospcRetry(() => fs.writeFile(path.join(this.requireStaging(), relPath), data));
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
      // Journalled only after the bytes are on disk, so a replayed journal
      // can never name an asset file that isn't there.
      await this.journal?.append({ t: 'asset', e: entry });
      return entry;
    })();
    this.assetWritesInFlight.set(hash, writePromise);
    try {
      return await writePromise;
    } finally {
      this.assetWritesInFlight.delete(hash);
    }
  }

  async addResponse(data: Buffer, url: string, normalizedUrl: string, contentType: string, status: number): Promise<ArchivedResponseEntry> {
    const hash = sha256(data);

    const existing = this.responses.get(hash);
    if (existing) return existing;

    const inFlight = this.responseWritesInFlight.get(hash);
    if (inFlight) return inFlight;

    const writePromise = (async (): Promise<ArchivedResponseEntry> => {
      const relPath = `responses/${hash}.json`;
      await writeWithEnospcRetry(() => fs.writeFile(path.join(this.requireStaging(), relPath), data));
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
      await this.journal?.append({ t: 'response', e: entry });
      await this.setRoute({ normalizedUrl, target: { type: 'response', sha256: hash } });
      return entry;
    })();
    this.responseWritesInFlight.set(hash, writePromise);
    try {
      return await writePromise;
    } finally {
      this.responseWritesInFlight.delete(hash);
    }
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
    forumThreadKey?: string;
    forumSectionKey?: string;
    forumPageIndex?: number;
  }): Promise<ArchivedPageEntry> {
    const staging = this.requireStaging();
    const htmlBuf = Buffer.from(input.html, 'utf8');
    const htmlPath = `pages/${input.pageId}.html`;
    await writeWithEnospcRetry(() => fs.writeFile(path.join(staging, htmlPath), htmlBuf));
    this.totalUncompressed += htmlBuf.length;

    let screenshotPath: string | null = null;
    let screenshotSha: string | null = null;
    if (input.screenshot) {
      screenshotPath = `screenshots/${input.pageId}.png`;
      await writeWithEnospcRetry(() => fs.writeFile(path.join(staging, screenshotPath!), input.screenshot!));
      screenshotSha = sha256(input.screenshot);
      this.totalUncompressed += input.screenshot.length;
    }

    let textPath: string | null = null;
    let textSha: string | null = null;
    if (input.text !== null) {
      const textBuf = Buffer.from(input.text, 'utf8');
      textPath = `pages/${input.pageId}.txt`;
      await writeWithEnospcRetry(() => fs.writeFile(path.join(staging, textPath!), textBuf));
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
      ...(input.forumThreadKey ? { forumThreadKey: input.forumThreadKey } : {}),
      ...(input.forumSectionKey ? { forumSectionKey: input.forumSectionKey } : {}),
      ...(input.forumPageIndex !== undefined ? { forumPageIndex: input.forumPageIndex } : {}),
    };
    this.pages.push(entry);
    this.pageNormalizedUrls.add(input.normalizedUrl);
    await this.journal?.append({ t: 'page', e: entry });

    // Route the page's own URL, plus every URL that redirected to it, so
    // links to any point in the redirect chain resolve offline.
    await this.setRoute({ normalizedUrl: input.normalizedUrl, target: { type: 'page', pageId: input.pageId } });
    for (const from of input.redirectedFrom) {
      await this.setRoute({ normalizedUrl: from, target: { type: 'page', pageId: input.pageId } });
    }
    return entry;
  }

  /** Point a normalized URL at an already-stored asset (for rewritten links). */
  async routeAsset(normalizedUrl: string, sha: string): Promise<void> {
    await this.setRoute({ normalizedUrl, target: { type: 'asset', sha256: sha } });
  }

  /**
   * Record one best-effort-extracted forum post. `bodyText` is written to
   * `posts/<postFileId>.txt` immediately (same "write bytes, then journal"
   * ordering as every other entry, and the same reason pageCapture.ts's
   * page bodies aren't held in memory for the whole crawl -- a large
   * thread can have thousands of posts). The file is read back once, at
   * writeIndexDatabase() time, to populate forum_posts_fts.
   */
  async addForumPost(entry: ForumPostEntry, bodyText: string): Promise<void> {
    if (this.seenForumPostIds.has(entry.postId)) return; // duplicate anchor on the same page -- see the field comment above
    this.seenForumPostIds.add(entry.postId);

    const staging = this.requireStaging();
    const fileId = sha256(entry.postId);
    await writeWithEnospcRetry(() => fs.writeFile(path.join(staging, 'posts', `${fileId}.txt`), bodyText, 'utf8'));
    this.totalUncompressed += Buffer.byteLength(bodyText, 'utf8');
    this.forumPosts.push(entry);
    await this.journal?.append({ t: 'forumPost', e: entry });
  }

  get forumPostCount(): number {
    return this.forumPosts.length;
  }

  async addFailure(failure: CaptureFailureEntry): Promise<void> {
    // Keep the list bounded so a pathological crawl can't grow the
    // manifest without limit.
    if (this.failures.length >= MAX_FAILURES) return;

    // Skips are cheap and numerous; genuine failures are what the user
    // needs to see. Without a separate ceiling, a link-dense site's skips
    // reach the global cap first and every later fetch failure or timeout
    // is silently dropped.
    if (failure.kind.startsWith('skipped-')) {
      const seen = (this.failureCountsByKind.get(failure.kind) ?? 0) + 1;
      this.failureCountsByKind.set(failure.kind, seen);
      if (seen > MAX_FAILURES_PER_SKIP_KIND) {
        if (seen === MAX_FAILURES_PER_SKIP_KIND + 1) {
          logger.info('sitearchive.skip_list_truncated', { kind: failure.kind });
        }
        return;
      }
    }

    this.failures.push(failure);
    await this.journal?.append({ t: 'failure', e: failure });
  }

  /** How many of each skip kind were seen, including any past the cap. */
  get skipCounts(): ReadonlyMap<string, number> {
    return this.failureCountsByKind;
  }

  get failureList(): CaptureFailureEntry[] {
    return this.failures;
  }

  /** Aggregate forum stats for the terminal progress/history summary. Distinct thread/section counts come from ArchivedPageEntry.forumThreadKey/forumSectionKey, since that's set on every page captured under a forum-* scope regardless of whether it had recognizable post markup. */
  private computeForumSummary(): ForumCaptureSummary {
    const threadKeys = new Set<string>();
    const sectionKeys = new Set<string>();
    let profileCount = 0;
    const PROFILE_URL_RE = /\/(members?|profile|user)\//i;
    for (const p of this.pages) {
      if (p.forumThreadKey) threadKeys.add(p.forumThreadKey);
      if (p.forumSectionKey) sectionKeys.add(p.forumSectionKey);
      if (!p.forumThreadKey && PROFILE_URL_RE.test(p.normalizedUrl)) profileCount += 1;
    }
    let attachmentCount = 0;
    for (const a of this.assets.values()) {
      if (a.kind === 'document') attachmentCount += 1;
    }
    return {
      sectionCount: sectionKeys.size,
      threadCount: threadKeys.size,
      postCount: this.forumPosts.length,
      attachmentCount,
      profileCount,
    };
  }

  /** Build the SQLite catalog that ships inside the container. */
  private async writeIndexDatabase(): Promise<{ buffer: Buffer; relPath: string }> {
    const staging = this.requireStaging();
    const dbPath = path.join(staging, 'index.sqlite');
    await fs.rm(dbPath, { force: true });

    // Read every page's extracted text back off disk now, rather than
    // holding it in memory for the whole crawl -- addPage() never keeps it
    // around after writing pages/<id>.txt (see there), and this is the one
    // place that needs it again, once, at the very end. A missing/unreadable
    // text file just means that page's FTS row has an empty body -- still
    // searchable by title, and not fatal to the rest of the catalog.
    const bodies = new Map<string, string>();
    for (const p of this.pages) {
      if (!p.textPath) continue;
      try {
        bodies.set(p.pageId, await fs.readFile(path.join(staging, p.textPath), 'utf8'));
      } catch {
        // handled by the ?? '' fallback below
      }
    }

    // Same read-back-at-finalize pattern as page bodies above, for the
    // per-post text files addForumPost() wrote during the crawl.
    const postBodies = new Map<string, string>();
    for (const post of this.forumPosts) {
      try {
        postBodies.set(post.postId, await fs.readFile(path.join(staging, 'posts', `${sha256(post.postId)}.txt`), 'utf8'));
      } catch {
        // handled by the ?? '' fallback below
      }
    }

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
        -- Full-text search over every page's title + extracted text, so
        -- "search inside this archive" doesn't mean decompressing and
        -- scanning every pages/<id>.txt file at query time.
        CREATE VIRTUAL TABLE pages_fts USING fts5(page_id UNINDEXED, title, body);
        -- Forum-only, one row per best-effort-extracted post (see
        -- forumPageScript.ts). Empty on any non-forum archive.
        CREATE TABLE forum_posts (
          post_id TEXT PRIMARY KEY,
          page_id TEXT NOT NULL,
          anchor TEXT NOT NULL,
          author TEXT,
          author_profile_url TEXT,
          timestamp TEXT,
          post_number INTEGER,
          thread_key TEXT NOT NULL,
          section_key TEXT,
          thread_title TEXT NOT NULL,
          section_title TEXT
        );
        CREATE INDEX idx_forum_posts_thread ON forum_posts(thread_key);
        CREATE VIRTUAL TABLE forum_posts_fts USING fts5(
          post_id UNINDEXED, author, thread_title, section_title, url, body
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
      const insertPageFts = db.prepare('INSERT INTO pages_fts (page_id, title, body) VALUES (?,?,?)');
      const insertForumPost = db.prepare(
        'INSERT INTO forum_posts (post_id, page_id, anchor, author, author_profile_url, timestamp, post_number, thread_key, section_key, thread_title, section_title) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      );
      const insertForumPostFts = db.prepare(
        'INSERT INTO forum_posts_fts (post_id, author, thread_title, section_title, url, body) VALUES (?,?,?,?,?,?)',
      );

      const pageByPageId = new Map(this.pages.map((p) => [p.pageId, p]));

      db.transaction(() => {
        for (const p of this.pages) {
          insertPage.run(p.pageId, p.originalUrl, p.finalUrl, p.normalizedUrl, p.title, p.depth, p.htmlPath, p.screenshotPath, p.textPath);
          insertPageFts.run(p.pageId, p.title, bodies.get(p.pageId) ?? '');
        }
        for (const a of this.assets.values()) {
          insertAsset.run(a.sha256, a.path, a.contentType, a.byteSize, a.kind, a.screenshotFallback ? 1 : 0);
          for (const url of a.sourceUrls) insertAssetUrl.run(url, a.sha256);
        }
        for (const r of this.routes.values()) {
          const targetId = r.target.type === 'page' ? r.target.pageId : r.target.sha256;
          insertRoute.run(r.normalizedUrl, r.target.type, targetId);
        }
        for (const post of this.forumPosts) {
          insertForumPost.run(
            post.postId,
            post.pageId,
            post.anchor,
            post.author,
            post.authorProfileUrl,
            post.timestamp,
            post.postNumber,
            post.threadKey,
            post.sectionKey,
            post.threadTitle,
            post.sectionTitle,
          );
          const url = pageByPageId.get(post.pageId)?.normalizedUrl ?? '';
          insertForumPostFts.run(post.postId, post.author ?? '', post.threadTitle, post.sectionTitle ?? '', url, postBodies.get(post.postId) ?? '');
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
      ...(this.forumPosts.length > 0 || input.scope.kind.startsWith('forum-')
        ? { forumPosts: this.forumPosts, forumSummary: this.computeForumSummary() }
        : {}),
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    await fs.writeFile(path.join(staging, 'manifest.json'), manifestJson, 'utf8');

    const tmpOut = `${input.finalPath}.tmp-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(input.finalPath), { recursive: true });

    try {
      await zipDirectory(staging, tmpOut, CHECKPOINT_FILES);
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

function zipDirectory(sourceDir: string, destZipPath: string, exclude: ReadonlySet<string>): Promise<void> {
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
        // Returning false from the entry callback drops that entry. The
        // crash-recovery journal lives in the staging tree but is
        // scaffolding, not archive content -- and it records the output
        // path and full URLs, which have no business being shipped inside
        // a file people share. Filtered rather than deleted so the capture
        // stays recoverable right up until the zip succeeds.
        archive.directory(sourceDir, false, (entry: { name: string }) =>
          exclude.has(entry.name) ? false : entry,
        );
        void archive.finalize();
      } catch (err) {
        reject(err);
      }
    })();
  });
}
