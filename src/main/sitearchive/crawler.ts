import crypto from 'node:crypto';
import path from 'node:path';
import { app, WebContentsView, type BrowserWindow, type Session } from 'electron';
import type {
  CaptureFailureEntry,
  CaptureProgress,
  CaptureResult,
  CaptureScope,
} from '../../shared/sitearchiveTypes';
import { SCOPE_HARD_LIMITS } from '../../shared/sitearchiveTypes';
import { SiteArchiveBuilder } from './archiveWriter';
import { capturePage, type DiscoveredLink } from './pageCapture';
import {
  hostOf,
  originOf,
  isHttpUrl,
  isInScope,
  looksDestructive,
  looksLikeCrawlerTrap,
  normalizeUrl,
} from './urlNormalize';
import { logger, redactUrl } from '../util/logger';

export type ProgressListener = (progress: CaptureProgress) => void;

interface QueueItem {
  url: string;
  depth: number;
  discoveredOn: string | null;
}

const RESOURCE_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS_PER_PAGE = 10;

/**
 * Crawls a site within scope and writes a .sitearchive.
 *
 * Pages are rendered in a hidden WebContentsView on the *live browsing
 * session*, so pages the user is logged into render as the user sees
 * them. Only rendered output is archived -- cookies, tokens, and headers
 * from that session are never written into the container.
 *
 * The crawl is strictly GET-only, same-origin by default, and bounded on
 * every axis (depth, page count, byte size, time per page). It can be
 * paused and cancelled, and reports progress continuously.
 */
export class CaptureJob {
  readonly jobId = crypto.randomUUID();
  private builder: SiteArchiveBuilder;
  private queue: QueueItem[] = [];
  private queuedOrDone = new Set<string>();
  private state: CaptureProgress['state'] = 'preparing';
  private pausedPromise: Promise<void> | null = null;
  private resumeFn: (() => void) | null = null;
  private cancelled = false;
  private pagesCompleted = 0;
  private pagesDiscovered = 0;
  private bytesDownloaded = 0;
  private warningCount = 0;
  private currentUrl: string | null = null;
  private siteTitle = '';
  private listeners: ProgressListener[] = [];
  private view: WebContentsView | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly session: Session,
    private readonly startUrl: string,
    private readonly scope: CaptureScope,
    private readonly outputPath: string,
  ) {
    this.builder = new SiteArchiveBuilder(crypto.randomUUID(), app.getVersion());
  }

  onProgress(listener: ProgressListener): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      state: this.state,
      siteTitle: this.siteTitle,
      startUrl: this.startUrl,
      scopeKind: this.scope.kind,
      pagesDiscovered: this.pagesDiscovered,
      pagesCompleted: this.pagesCompleted,
      currentUrl: this.currentUrl,
      bytesDownloaded: this.bytesDownloaded,
      warningCount: this.warningCount,
      failureCount: this.builder.failureList.length,
    };
    for (const l of this.listeners) l(progress);
  }

  private emitTerminal(extra: Partial<CaptureProgress>): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      state: this.state,
      siteTitle: this.siteTitle,
      startUrl: this.startUrl,
      scopeKind: this.scope.kind,
      pagesDiscovered: this.pagesDiscovered,
      pagesCompleted: this.pagesCompleted,
      currentUrl: null,
      bytesDownloaded: this.bytesDownloaded,
      warningCount: this.warningCount,
      failureCount: this.builder.failureList.length,
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
    // If paused, unblock so the loop can observe the cancellation.
    this.resumeFn?.();
    this.resumeFn = null;
    this.pausedPromise = null;
  }

  private async waitIfPaused(): Promise<void> {
    if (this.pausedPromise) await this.pausedPromise;
  }

  async run(): Promise<CaptureResult> {
    const startOrigin = originOf(this.startUrl);
    const startHost = hostOf(this.startUrl);
    if (!startOrigin || !startHost || !isHttpUrl(this.startUrl)) {
      throw new Error('Capture can only start from an http(s) page');
    }

    await this.builder.init(app.getPath('temp'));

    // A hidden view so crawling never disturbs the user's actual tab.
    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: true,
        images: true,
        offscreen: false,
      },
    });
    this.window.contentView.addChildView(this.view);
    // Give it a real size so layout/lazy-loading behave like a normal
    // viewport, but keep it behind the visible UI at zero-ish position.
    this.view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    this.view.setVisible(false);

    this.state = 'running';
    const startNormalized = normalizeUrl(this.startUrl);
    if (!startNormalized) throw new Error('Start URL could not be normalized');

    this.enqueue({ url: this.startUrl, depth: 0, discoveredOn: null });
    this.emit();

    let startFinalUrl = this.startUrl;

    try {
      while (this.queue.length > 0 && !this.cancelled) {
        await this.waitIfPaused();
        if (this.cancelled) break;

        if (this.pagesCompleted >= this.scope.maxPages) {
          logger.info('sitearchive.page_limit_reached', { limit: this.scope.maxPages });
          break;
        }
        if (this.builder.totalBytes >= this.scope.maxTotalBytes) {
          logger.info('sitearchive.size_limit_reached', {});
          break;
        }

        const item = this.queue.shift()!;
        this.currentUrl = item.url;
        this.emit();

        const captured = await this.capturePageSafely(item, startOrigin);
        if (captured?.isStart) startFinalUrl = captured.finalUrl;

        // Politeness delay between page loads.
        if (this.scope.crawlDelayMs > 0 && this.queue.length > 0) {
          await sleep(this.scope.crawlDelayMs);
        }
      }

      if (this.cancelled) {
        this.state = 'cancelled';
        this.builder.addFailure({
          url: this.currentUrl ?? this.startUrl,
          kind: 'cancelled',
          message: 'Capture was cancelled by the user',
          discoveredOn: null,
        });
        // Nothing is written to the final path on cancel, so no previous
        // archive at that path is ever damaged.
        await this.builder.cleanup();
        this.emitTerminal({ state: 'cancelled' });
        throw new CaptureCancelledError();
      }

      this.state = 'finalizing';
      this.currentUrl = null;
      this.emit();

      const { fileSizeBytes } = await this.builder.finalize({
        finalPath: this.outputPath,
        startUrl: this.startUrl,
        startFinalUrl,
        siteTitle: this.siteTitle || startHost,
        scope: this.scope,
      });

      const result: CaptureResult = {
        archivePath: this.outputPath,
        pageCount: this.builder.pageCount,
        assetCount: this.builder.assetCount,
        fileSizeBytes,
        failures: this.builder.failureList,
      };

      this.state = 'completed';
      this.emitTerminal({ state: 'completed', result });
      return result;
    } catch (err) {
      if (err instanceof CaptureCancelledError) throw err;
      this.state = 'failed';
      this.emitTerminal({ state: 'failed', error: describe(err) });
      throw err;
    } finally {
      await this.builder.cleanup().catch(() => {});
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

  private enqueue(item: QueueItem): void {
    const normalized = normalizeUrl(item.url);
    if (!normalized) return;
    if (this.queuedOrDone.has(normalized)) return;
    this.queuedOrDone.add(normalized);
    this.queue.push(item);
    this.pagesDiscovered += 1;
  }

  private async capturePageSafely(
    item: QueueItem,
    startOrigin: string,
  ): Promise<{ isStart: boolean; finalUrl: string } | null> {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return null;

    const normalized = normalizeUrl(item.url);
    if (!normalized) {
      this.recordFailure({ url: item.url, kind: 'skipped-non-http', message: 'Not an http(s) URL', discoveredOn: item.discoveredOn });
      return null;
    }

    try {
      const loaded = await this.loadUrl(view.webContents, item.url);
      if (!loaded.ok) {
        this.recordFailure({
          url: item.url,
          kind: loaded.kind,
          message: loaded.message,
          discoveredOn: item.discoveredOn,
        });
        return null;
      }

      const finalUrl = view.webContents.getURL();
      const finalNormalized = normalizeUrl(finalUrl) ?? normalized;

      // A redirect may have landed us somewhere already captured.
      if (finalNormalized !== normalized && this.builder.hasPageForNormalizedUrl(finalNormalized)) {
        this.recordFailure({
          url: item.url,
          kind: 'skipped-duplicate',
          message: `Redirected to an already-captured page (${finalNormalized})`,
          discoveredOn: item.discoveredOn,
        });
        return null;
      }

      // A redirect must not carry us outside the capture scope.
      if (
        !isInScope({
          url: finalUrl,
          startOrigin,
          allowedDomains: this.scope.allowedDomains,
          includeExternalDomains: this.scope.includeExternalDomains,
        })
      ) {
        this.recordFailure({
          url: item.url,
          kind: 'skipped-scope',
          message: `Redirected out of scope to ${finalUrl}`,
          discoveredOn: item.discoveredOn,
        });
        return null;
      }

      // Let client-rendered content settle before serializing.
      await sleep(600);

      const result = await capturePage(
        view.webContents,
        {
          builder: this.builder,
          session: this.session,
          scope: this.scope,
          startOrigin,
          maxResourceBytes: MAX_RESOURCE_BYTES,
          resourceTimeoutMs: RESOURCE_TIMEOUT_MS,
        },
        {
          originalUrl: item.url,
          finalUrl,
          normalizedUrl: finalNormalized,
          depth: item.depth,
          redirectedFrom: finalNormalized !== normalized ? [normalized] : [],
        },
      );

      this.pagesCompleted += 1;
      this.bytesDownloaded += result.bytesDownloaded;
      this.warningCount += result.warnings.length;
      if (!this.siteTitle) this.siteTitle = result.title;

      // Discover further pages, unless we've hit the depth limit.
      if (item.depth < this.scope.maxDepth) {
        this.discoverLinks(result.links, finalUrl, item.depth + 1, startOrigin);
      }

      this.emit();
      return { isStart: item.depth === 0, finalUrl };
    } catch (err) {
      this.recordFailure({
        url: item.url,
        kind: 'render-failed',
        message: describe(err),
        discoveredOn: item.discoveredOn,
      });
      return null;
    }
  }

  private discoverLinks(links: DiscoveredLink[], pageUrl: string, nextDepth: number, startOrigin: string): void {
    for (const link of links) {
      if (this.pagesDiscovered >= SCOPE_HARD_LIMITS.maxPages) return;

      const absolute = link.url;
      if (!isHttpUrl(absolute)) continue; // mailto:, tel:, javascript: etc. are never crawled

      // Never follow a link that looks like it performs an action, and
      // never follow links inside forms (they're usually submit-adjacent).
      if (looksDestructive(absolute)) {
        this.recordFailure({ url: absolute, kind: 'skipped-sensitive', message: 'Link looks like a state-changing action', discoveredOn: pageUrl });
        continue;
      }
      if (link.insideForm) continue;
      if (link.rel.includes('nofollow')) continue;

      if (
        !isInScope({
          url: absolute,
          startOrigin,
          allowedDomains: this.scope.allowedDomains,
          includeExternalDomains: this.scope.includeExternalDomains,
        })
      ) {
        continue; // out of scope is normal, not a failure worth listing
      }

      if (looksLikeCrawlerTrap(absolute)) {
        this.recordFailure({ url: absolute, kind: 'skipped-trap', message: 'URL matched a crawler-trap heuristic', discoveredOn: pageUrl });
        continue;
      }

      // Downloadable documents are captured as assets, not crawled as pages.
      if (link.download) continue;

      this.enqueue({ url: absolute, depth: nextDepth, discoveredOn: pageUrl });
    }
  }

  private recordFailure(failure: CaptureFailureEntry): void {
    this.builder.addFailure(failure);
    this.emit();
  }

  /**
   * Navigate the hidden view, with a hard timeout and redirect-loop
   * detection. Resolves with ok:false rather than throwing so one bad page
   * never aborts the whole crawl.
   */
  private loadUrl(
    webContents: Electron.WebContents,
    url: string,
  ): Promise<{ ok: true } | { ok: false; kind: CaptureFailureEntry['kind']; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let redirects = 0;
      const seenRedirects = new Set<string>();

      const cleanup = () => {
        clearTimeout(timer);
        webContents.removeListener('did-finish-load', onFinish);
        webContents.removeListener('did-fail-load', onFail);
        webContents.removeListener('did-redirect-navigation', onRedirect);
      };
      const finish = (value: { ok: true } | { ok: false; kind: CaptureFailureEntry['kind']; message: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => {
        try {
          webContents.stop();
        } catch {
          /* ignore */
        }
        finish({ ok: false, kind: 'timeout', message: 'Page load timed out' });
      }, PAGE_LOAD_TIMEOUT_MS);

      const onFinish = () => finish({ ok: true });
      const onFail = (_e: unknown, errorCode: number, description: string, _u: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        if (errorCode === -3) return; // ERR_ABORTED, e.g. a redirect superseding
        finish({ ok: false, kind: 'fetch-failed', message: `${description} (${errorCode})` });
      };
      const onRedirect = (_e: unknown, redirectUrl: string) => {
        redirects += 1;
        const norm = normalizeUrl(redirectUrl) ?? redirectUrl;
        if (seenRedirects.has(norm) || redirects > MAX_REDIRECTS_PER_PAGE) {
          try {
            webContents.stop();
          } catch {
            /* ignore */
          }
          finish({ ok: false, kind: 'redirect-loop', message: 'Redirect loop detected' });
          return;
        }
        seenRedirects.add(norm);
      };

      webContents.on('did-finish-load', onFinish);
      webContents.on('did-fail-load', onFail);
      webContents.on('did-redirect-navigation', onRedirect);

      webContents.loadURL(url).catch((err: unknown) => {
        finish({ ok: false, kind: 'fetch-failed', message: describe(err) });
      });
    });
  }
}

export class CaptureCancelledError extends Error {
  constructor() {
    super('Capture cancelled');
    this.name = 'CaptureCancelledError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Suggest a filename for an archive of `url`. */
export function suggestArchiveFilename(url: string, title: string): string {
  const host = hostOf(url) ?? 'website';
  const base = (title || host).replace(/[/\\?%*:|"<>]/g, '-').trim().slice(0, 80) || host;
  return `${base}.sitearchive`;
}

export { path };
