import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app, WebContentsView, type BrowserWindow, type Session } from 'electron';
import type {
  ArchivedPageEntry,
  CaptureFailureEntry,
  CaptureFailureKind,
  CaptureProgress,
  CaptureResult,
  SiteArchiveManifest,
} from '../../shared/sitearchiveTypes';
import { SiteArchiveBuilder } from './archiveWriter';
import { openSiteArchive, type OpenedArchive } from './archiveReader';
import { capturePage } from './pageCapture';
import {
  loadUrl,
  RESOURCE_TIMEOUT_MS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_BYTES_WITH_MEDIA,
  ASSET_CONCURRENCY,
  ASSET_CONCURRENCY_WITH_MEDIA,
  PAGE_CAPTURE_BUDGET_MS,
} from './crawler';
import { normalizeUrl, originOf } from './urlNormalize';
import { logger } from '../util/logger';

export type ProgressListener = (progress: CaptureProgress) => void;

/**
 * Failure kinds that represent a genuine attempt to capture a *page*,
 * which is what "retry" can meaningfully redo. Everything else is either
 * an intentional link-level skip (never attempted -- retrying would just
 * skip it again for the same reason), an asset/resource-level failure
 * inside an otherwise-successful page, or an administrative record
 * (`stopped-at-limit`, `cancelled`) that doesn't name a page to recapture.
 */
const RETRYABLE_PAGE_FAILURE_KINDS: ReadonlySet<CaptureFailureKind> = new Set([
  'fetch-failed',
  'http-error',
  'timeout',
  'too-large',
  'redirect-loop',
  'render-failed',
  'serialize-failed',
  'interrupted',
]);

/** Which of a finalized archive's recorded failures retryFailedPages() would actually retry. */
export function retryableFailures(failures: readonly CaptureFailureEntry[]): CaptureFailureEntry[] {
  const seen = new Set<string>();
  const result: CaptureFailureEntry[] = [];
  for (const f of failures) {
    if (!RETRYABLE_PAGE_FAILURE_KINDS.has(f.kind)) continue;
    const key = normalizeUrl(f.url) ?? f.url;
    if (seen.has(key)) continue; // a URL is only ever retried once, even if it failed more than once
    seen.add(key);
    result.push(f);
  }
  return result;
}

/**
 * Best-effort depth for a retried page, for display only (retry never
 * discovers further links, so depth has no bearing on what gets crawled).
 * Falls back to 0 when the discovering page isn't known or wasn't itself
 * successfully captured.
 */
export function inferDepth(discoveredOn: string | null, pageByNormalizedUrl: Map<string, ArchivedPageEntry>): number {
  if (!discoveredOn) return 0;
  const parent = pageByNormalizedUrl.get(normalizeUrl(discoveredOn) ?? discoveredOn);
  return parent ? parent.depth + 1 : 0;
}

/** Copy every existing page/asset/response file from the opened archive into a fresh staging tree, byte for byte. */
async function copyExistingEntriesIntoStaging(
  archive: OpenedArchive,
  manifest: SiteArchiveManifest,
  stagingDir: string,
): Promise<void> {
  for (const p of manifest.pages) {
    const html = await archive.readEntry(p.htmlPath, p.htmlSha256);
    await fs.writeFile(path.join(stagingDir, p.htmlPath), html);
    if (p.screenshotPath && p.screenshotSha256) {
      const shot = await archive.readEntry(p.screenshotPath, p.screenshotSha256);
      await fs.writeFile(path.join(stagingDir, p.screenshotPath), shot);
    }
    if (p.textPath && p.textSha256) {
      const text = await archive.readEntry(p.textPath, p.textSha256);
      await fs.writeFile(path.join(stagingDir, p.textPath), text);
    }
  }
  for (const a of manifest.assets) {
    const bytes = await archive.readEntry(a.path, a.sha256);
    await fs.writeFile(path.join(stagingDir, a.path), bytes);
  }
  for (const r of manifest.responses) {
    const bytes = await archive.readEntry(r.path, r.sha256);
    await fs.writeFile(path.join(stagingDir, r.path), bytes);
  }
}

/**
 * Re-attempt exactly the pages a finished .sitearchive recorded as failed,
 * without re-crawling or re-fetching anything that already succeeded.
 *
 * Unlike CaptureJob's crash resume (which continues an *unfinished*
 * staging tree from its journal), this starts from an already-finalized
 * archive: its content is copied into a fresh staging tree byte for byte,
 * the builder is seeded directly from the manifest, and only the
 * previously-failed URLs are attempted again. No further links are
 * discovered from a newly-recovered page -- that would reopen the "resume
 * the whole crawl" complexity this feature exists to avoid.
 *
 * If this crashes or is killed partway through, the original archive file
 * is untouched: finalize() only replaces it, atomically, on full success
 * (see SiteArchiveBuilder.finalize -- the same fs.rename-over-existing-
 * file guarantee every other capture already relies on).
 */
export class RetryJob {
  readonly jobId = crypto.randomUUID();
  private listeners: ProgressListener[] = [];
  private state: CaptureProgress['state'] = 'preparing';
  private cancelled = false;
  private pausedPromise: Promise<void> | null = null;
  private resumeFn: (() => void) | null = null;
  private attempted = 0;
  private succeeded = 0;
  private bytesDownloaded = 0;
  private warningCount = 0;
  private currentUrl: string | null = null;
  private siteTitle = '';
  private startUrl = '';
  private scopeKind: CaptureProgress['scopeKind'] = 'custom';
  private totalRetryable = 0;
  private builder: SiteArchiveBuilder | null = null;
  private view: WebContentsView | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly session: Session,
    private readonly archivePath: string,
  ) {}

  onProgress(listener: ProgressListener): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      kind: 'retry',
      state: this.state,
      siteTitle: this.siteTitle,
      startUrl: this.startUrl,
      scopeKind: this.scopeKind,
      pagesDiscovered: this.totalRetryable,
      pagesCompleted: this.attempted,
      currentUrl: this.currentUrl,
      bytesDownloaded: this.bytesDownloaded,
      warningCount: this.warningCount,
      failureCount: this.builder?.failureList.length ?? 0,
    };
    for (const l of this.listeners) l(progress);
  }

  private emitTerminal(extra: Partial<CaptureProgress>): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      kind: 'retry',
      state: this.state,
      siteTitle: this.siteTitle,
      startUrl: this.startUrl,
      scopeKind: this.scopeKind,
      pagesDiscovered: this.totalRetryable,
      pagesCompleted: this.attempted,
      currentUrl: null,
      bytesDownloaded: this.bytesDownloaded,
      warningCount: this.warningCount,
      failureCount: this.builder?.failureList.length ?? 0,
      ...extra,
    };
    for (const l of this.listeners) l(progress);
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.pausedPromise = new Promise<void>((resolve) => {
      this.resumeFn = resolve;
    });
    this.emit();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.resumeFn?.();
    this.resumeFn = null;
    this.pausedPromise = null;
    this.emit();
  }

  cancel(): void {
    this.cancelled = true;
    this.resumeFn?.();
    this.resumeFn = null;
    this.pausedPromise = null;
  }

  private async waitIfPaused(): Promise<void> {
    if (this.pausedPromise) await this.pausedPromise;
  }

  async run(): Promise<CaptureResult> {
    const archive = await openSiteArchive(this.archivePath);
    const manifest = archive.manifest;
    this.siteTitle = manifest.siteTitle;
    this.startUrl = manifest.startUrl;
    this.scopeKind = manifest.scope.kind;

    const retryable = retryableFailures(manifest.failures);
    this.totalRetryable = retryable.length;

    if (retryable.length === 0) {
      archive.close();
      const stat = await fs.stat(this.archivePath);
      this.state = 'completed';
      const result: CaptureResult = {
        archivePath: this.archivePath,
        pageCount: manifest.pages.length,
        assetCount: manifest.assets.length,
        fileSizeBytes: stat.size,
        failures: manifest.failures,
      };
      this.emitTerminal({ state: 'completed', result });
      return result;
    }

    const pageByNormalizedUrl = new Map(manifest.pages.map((p) => [p.normalizedUrl, p]));
    const builder = new SiteArchiveBuilder(manifest.archiveId, app.getVersion());
    this.builder = builder;

    try {
      await builder.init(app.getPath('temp'));
      await copyExistingEntriesIntoStaging(archive, manifest, builder.stagingPath!);
      builder.restoreFromManifest(
        manifest,
        new Set(retryable.map((f) => normalizeUrl(f.url) ?? f.url)),
      );
    } finally {
      archive.close();
    }

    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: true,
        images: true,
      },
    });
    this.window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    this.view.setVisible(false);

    this.state = 'running';
    this.emit();

    const startOrigin = originOf(manifest.startUrl) ?? manifest.startUrl;

    try {
      for (const failure of retryable) {
        await this.waitIfPaused();
        if (this.cancelled) break;

        this.currentUrl = failure.url;
        this.emit();

        await this.retryOne(failure, manifest, builder, pageByNormalizedUrl, startOrigin);
        this.attempted += 1;
        this.emit();
      }

      if (this.cancelled) {
        this.state = 'cancelled';
        this.emitTerminal({ state: 'cancelled' });
        throw new RetryCancelledError();
      }

      this.state = 'finalizing';
      this.currentUrl = null;
      this.emit();

      const { fileSizeBytes } = await builder.finalize({
        finalPath: this.archivePath,
        startUrl: manifest.startUrl,
        startFinalUrl: manifest.startFinalUrl,
        siteTitle: manifest.siteTitle,
        scope: manifest.scope,
      });

      const result: CaptureResult = {
        archivePath: this.archivePath,
        pageCount: builder.pageCount,
        assetCount: builder.assetCount,
        fileSizeBytes,
        failures: builder.failureList,
      };
      logger.info('sitearchive.retry_completed', {
        jobId: this.jobId,
        attempted: this.attempted,
        succeeded: this.succeeded,
        stillFailing: builder.failureList.length,
      });
      this.state = 'completed';
      this.emitTerminal({ state: 'completed', result });
      return result;
    } catch (err) {
      if (err instanceof RetryCancelledError) throw err;
      this.state = 'failed';
      this.emitTerminal({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      await builder.cleanup().catch(() => {});
      this.destroyView();
    }
  }

  private destroyView(): void {
    if (!this.view) return;
    try {
      this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    } catch {
      /* window may already be gone */
    }
    this.view = null;
  }

  /** Attempt one previously-failed URL; adds a page on success, a fresh failure entry otherwise. */
  private async retryOne(
    failure: CaptureFailureEntry,
    manifest: SiteArchiveManifest,
    builder: SiteArchiveBuilder,
    pageByNormalizedUrl: Map<string, ArchivedPageEntry>,
    startOrigin: string,
  ): Promise<void> {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) {
      await builder.addFailure(failure);
      return;
    }

    const normalized = normalizeUrl(failure.url);
    if (!normalized) {
      await builder.addFailure(failure);
      return;
    }

    try {
      const loaded = await loadUrl(view.webContents, failure.url);
      if (!loaded.ok) {
        await builder.addFailure({ url: failure.url, kind: loaded.kind, message: loaded.message, discoveredOn: failure.discoveredOn });
        return;
      }

      const finalUrl = view.webContents.getURL();
      const finalNormalized = normalizeUrl(finalUrl) ?? normalized;

      if (finalNormalized !== normalized && builder.hasPageForNormalizedUrl(finalNormalized)) {
        await builder.addFailure({
          url: failure.url,
          kind: 'skipped-duplicate',
          message: `Redirected to an already-captured page (${finalNormalized})`,
          discoveredOn: failure.discoveredOn,
        });
        return;
      }

      // Let client-rendered content settle before serializing -- same
      // pause capturePageSafely() uses for a freshly-loaded page.
      await sleep(600);

      const result = await capturePage(
        view.webContents,
        {
          builder,
          session: this.session,
          scope: manifest.scope,
          startOrigin,
          maxResourceBytes: manifest.scope.includeMedia ? MAX_RESOURCE_BYTES_WITH_MEDIA : MAX_RESOURCE_BYTES,
          resourceTimeoutMs: RESOURCE_TIMEOUT_MS,
          assetConcurrency: manifest.scope.includeMedia ? ASSET_CONCURRENCY_WITH_MEDIA : ASSET_CONCURRENCY,
          pageBudgetMs: PAGE_CAPTURE_BUDGET_MS,
        },
        {
          originalUrl: failure.url,
          finalUrl,
          normalizedUrl: finalNormalized,
          depth: inferDepth(failure.discoveredOn, pageByNormalizedUrl),
          redirectedFrom: finalNormalized !== normalized ? [normalized] : [],
        },
      );

      this.succeeded += 1;
      this.bytesDownloaded += result.bytesDownloaded;
      this.warningCount += result.warnings.length;
    } catch (err) {
      await builder.addFailure({
        url: failure.url,
        kind: 'render-failed',
        message: err instanceof Error ? err.message : String(err),
        discoveredOn: failure.discoveredOn,
      });
    }
  }
}

export class RetryCancelledError extends Error {
  constructor() {
    super('Retry cancelled');
    this.name = 'RetryCancelledError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
