import crypto from 'node:crypto';
import path from 'node:path';
import { app, WebContentsView, type BrowserWindow, type Session } from 'electron';
import type {
  CaptureFailureEntry,
  CaptureProgress,
  CaptureResult,
  CaptureScope,
} from '../../shared/sitearchiveTypes';
import { SCOPE_HARD_LIMITS, MIN_FREE_DISK_BYTES } from '../../shared/sitearchiveTypes';
import { getDiskSpace } from '../capture/diskSpace';
import { sampleCaptureMemory } from '../capture/memoryTelemetry';
import { SiteArchiveBuilder } from './archiveWriter';
import { CaptureJournal, type ReplayedCheckpoint } from './captureJournal';
import { CrawlFrontier } from './crawlFrontier';
import { capturePage, type DiscoveredLink } from './pageCapture';
import {
  hostOf,
  originOf,
  isHttpUrl,
  isInScope,
  looksDestructive,
  looksLikeCrawlerTrap,
  looksNonContent,
  normalizeUrl,
} from './urlNormalize';
import {
  looksLikeAttachment,
  looksLikeForumPagination,
  looksLikePrintOrAlternateView,
  sectionKeyOf,
  threadKeyOf,
} from './forumLinks';
import { fetchRobotsRules, isAllowedByRobots, type RobotsRules } from './robots';
import { logger, redactUrl } from '../util/logger';

/** True for any of the three forum-flavored scope kinds. */
function isForumScopeKind(kind: CaptureScope['kind']): boolean {
  return kind === 'forum-thread' || kind === 'forum-section' || kind === 'forum-whole';
}

/** Bounds a pagination chain so a genuine trap disguised as pagination still terminates. */
const MAX_PAGINATION_HOPS_PER_UNIT = 500;

/** The first path segment of a URL, e.g. "/forum" from "/forum/section-1". Empty string for a root-level URL. */
function leadingPathSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > 0 ? `/${segments[0]}` : '';
  } catch {
    return '';
  }
}

export type ProgressListener = (progress: CaptureProgress) => void;

interface QueueItem {
  url: string;
  depth: number;
  discoveredOn: string | null;
  /**
   * For forum-section/forum-whole scopes: the section this item belongs
   * to, inherited from whichever ancestor page first "looks like" a
   * section (see discoverLinks). Undefined until something in the chain
   * establishes one -- e.g. the forum root itself has none yet.
   */
  forumSectionKey?: string;
}

/** Everything needed to pick a killed capture back up where it stopped. */
export interface ResumeState {
  stagingDir: string;
  checkpoint: ReplayedCheckpoint;
}

// Exported: retryFailedPages.ts reuses these so a retried page is bound by
// exactly the same per-page ceilings as a page captured during the
// original crawl, rather than a second set of numbers that could drift.
export const RESOURCE_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
/**
 * Per-resource ceiling.
 *
 * Responses are buffered in memory before being written, so this bound
 * multiplied by the asset concurrency is the worst-case peak memory of a
 * single page's fetch phase. An earlier 512MB media ceiling combined with
 * 8-way concurrency allowed ~4GB in flight, which killed the process
 * mid-crawl on a media-heavy site. Media gets a raised-but-bounded cap,
 * and concurrency is reduced when media is enabled so the product stays
 * modest (96MB x 3 ~= 288MB worst case).
 */
export const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_RESOURCE_BYTES_WITH_MEDIA = 96 * 1024 * 1024;
/**
 * Subresources of a single page fetched at once. Browsers routinely open
 * ~6 connections per host, so this is ordinary load, not aggressive --
 * and page-to-page politeness is still governed by scope.crawlDelayMs.
 */
export const ASSET_CONCURRENCY = 8;
/** Lower when media is on, since each in-flight response can be far larger. */
export const ASSET_CONCURRENCY_WITH_MEDIA = 3;
/** Rebuild the crawling view this often, to bound renderer memory growth. */
const PAGES_PER_VIEW_RECYCLE = 20;
const MAX_REDIRECTS_PER_PAGE = 10;
/**
 * Consecutive viewport-only screenshot fallbacks before the view is
 * rebuilt early.
 *
 * Observed on a real 810-page crawl: after page 346 every single
 * remaining page fell back to a viewport crop -- 464 in a row, with no
 * recovery -- while the capture still reported success. Whatever wedges
 * the renderer that way survives an ordinary page navigation, so a run of
 * failures is treated as a signal to tear the view down early rather than
 * something to keep quietly absorbing.
 */
const MAX_CONSECUTIVE_SCREENSHOT_DEGRADATIONS = 3;
/**
 * Wall-clock ceiling for capturing a single page.
 *
 * A real forum photo thread (116 images, 27 dead third-party hosts, heavy
 * ad tags) ran over 15 minutes on one page without finishing. Nothing
 * bounded it: navigation and each individual fetch have timeouts, but the
 * capture phases had no collective limit, so one page could hold a crawl
 * open forever. Two minutes is far above a normal page (~7s measured on a
 * large marketing site) and still lets a 50,000-page crawl make progress.
 */
export const PAGE_CAPTURE_BUDGET_MS = 120_000;
/**
 * How long an idle worker waits before rechecking the queue.
 *
 * An idle worker (queue momentarily empty, but another worker is still
 * busy and might discover more links) can't just exit -- but it also
 * shouldn't busy-loop. This is short enough that a worker picks up newly
 * discovered work almost immediately, and long enough not to matter for
 * CPU use against page loads that take seconds.
 */
const WORKER_IDLE_POLL_MS = 100;

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
  private queue = new CrawlFrontier();
  private queuedOrDone = new Set<string>();
  /**
   * Normalized URLs already recorded as skipped.
   *
   * Skips are decided in discoverLinks, before enqueue() -- so they never
   * reach the queuedOrDone dedupe. Without this, a link in the site's
   * global navigation (a "Log in" or "Members" link on every page) records
   * an identical failure entry once per page crawled, filling the capture's
   * failure list with hundreds of copies of the same skip and pushing out
   * the real failures the user needs to see.
   */
  private skippedUrls = new Set<string>();
  /**
   * For forum-thread/forum-section scopes: the thread/section identity of
   * the starting URL, computed once in run(). A link is only in scope for
   * these narrow kinds when its own threadKeyOf/sectionKeyOf matches.
   */
  private startThreadKey: string | null = null;
  private startSectionKey: string | null = null;
  /**
   * For forum-section: the section URL's leading path segment (e.g.
   * "/forum" from "/forum/section-1"), used to keep a "thread from this
   * section" link actually forum-shaped. Without this, an ordinary global
   * nav link (Home, About, a product page) discovered on the section
   * index page satisfies "not the section's own pagination, discovered
   * from a page in this section" just as well as a real thread would.
   */
  private forumRootPrefix: string | null = null;
  /** How many pagination hops have been followed for each thread/section key, bounding an otherwise-unbounded pagination chain. */
  private paginationHopCounts = new Map<string, number>();
  /** 1-based page-within-thread counter, keyed by forumThreadKey. */
  private forumPageIndexByThreadKey = new Map<string, number>();
  /** robots.txt rules for the start origin, fetched once in run(). Empty (allow-all) when unreachable/unparseable or when the scope isn't a forum-* kind. */
  private robotsRules: RobotsRules = { rules: [] };
  private state: CaptureProgress['state'] = 'preparing';
  private pausedPromise: Promise<void> | null = null;
  private resumeFn: (() => void) | null = null;
  private cancelled = false;
  private pagesCompleted = 0;
  /**
   * Pages claimed by a worker but not yet resolved (success or failure).
   *
   * `pagesCompleted + pagesInFlight` is the number the maxPages check
   * compares against, not `pagesCompleted` alone -- see runWorker() for
   * why: checking completed-only lets multiple workers each see room
   * under the budget before any of them finishes, overshooting maxPages
   * by up to (concurrency - 1) pages.
   */
  private pagesInFlight = 0;
  private pagesDiscovered = 0;
  private bytesDownloaded = 0;
  private warningCount = 0;
  /** Whichever page most recently started, across every worker -- see runWorker(). */
  private currentUrl: string | null = null;
  private siteTitle = '';
  private listeners: ProgressListener[] = [];
  /** One hidden view per worker, indexed the same as `workers` below. */
  private views: (WebContentsView | null)[] = [];
  private degradedScreenshotCount = 0;
  /**
   * Per-worker state that used to be single shared fields, before pages
   * were captured in parallel (see runWorker()). Each worker gets its own
   * screenshot-degradation streak and view-recycle countdown because both
   * are about *that worker's own renderer* looking wedged or having grown
   * -- a different worker's renderer is a different process, unaffected.
   */
  private workers: Array<{
    consecutiveScreenshotDegradations: number;
    forceViewRecycle: boolean;
    pagesSinceRecycle: number;
  }> = [];
  /** How many workers are mid-page right now -- see runWorker()'s termination check. */
  private busyWorkers = 0;
  /** Only the first worker to notice a stop condition should record why. */
  private stopReasonRecorded = false;
  private journal: CaptureJournal | null = null;
  /** Set when the run failed in a way the user could still recover from. */
  private keepStagingForRecovery = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly session: Session,
    private readonly startUrl: string,
    private readonly scope: CaptureScope,
    private readonly outputPath: string,
    private readonly resumeFrom: ResumeState | null = null,
  ) {
    // A resumed capture must keep the original archive id: it is baked
    // into the `archive-site://<archiveId>` origins already serialized
    // into every page captured before the interruption, and into the
    // staging directory's name.
    this.builder = new SiteArchiveBuilder(
      resumeFrom?.checkpoint.meta.archiveId ?? crypto.randomUUID(),
      app.getVersion(),
    );
  }

  onProgress(listener: ProgressListener): void {
    this.listeners.push(listener);
  }

  private forumProgressFields(): Pick<CaptureProgress, 'threadsSaved' | 'imagesSaved'> {
    if (!isForumScopeKind(this.scope.kind)) return {};
    return {
      threadsSaved: this.forumPageIndexByThreadKey.size,
      imagesSaved: this.builder.assetCount,
    };
  }

  private emit(): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      kind: 'capture',
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
      ...this.forumProgressFields(),
    };
    for (const l of this.listeners) l(progress);
  }

  private emitTerminal(extra: Partial<CaptureProgress>): void {
    const progress: CaptureProgress = {
      jobId: this.jobId,
      kind: 'capture',
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
      ...this.forumProgressFields(),
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

    const startNormalized = normalizeUrl(this.startUrl);
    if (!startNormalized) throw new Error('Start URL could not be normalized');

    if (isForumScopeKind(this.scope.kind)) {
      if (this.scope.kind === 'forum-thread') this.startThreadKey = threadKeyOf(startNormalized);
      if (this.scope.kind === 'forum-section') {
        this.startSectionKey = sectionKeyOf(startNormalized);
        this.forumRootPrefix = leadingPathSegment(startNormalized);
      }
      this.robotsRules = await fetchRobotsRules(startOrigin, this.session);
    }

    if (this.resumeFrom) {
      // Every byte captured before the interruption is still in the
      // staging tree; only the bookkeeping needs rebuilding.
      await this.builder.initForResume(this.resumeFrom.stagingDir);
      this.builder.restore(this.resumeFrom.checkpoint);
      this.restoreCrawlState(this.resumeFrom.checkpoint);
      this.journal = await CaptureJournal.reopen(this.resumeFrom.stagingDir);
      logger.info('sitearchive.capture_resumed', {
        archiveId: this.builder.archiveId,
        pagesAlreadyCaptured: this.pagesCompleted,
        queueRemaining: this.queue.size,
      });
    } else {
      await this.builder.init(app.getPath('temp'));
      this.journal = await CaptureJournal.create(this.builder.stagingPath!, {
        archiveId: this.builder.archiveId,
        appVersion: app.getVersion(),
        startUrl: this.startUrl,
        outputPath: this.outputPath,
        scope: this.scope,
        startedAt: new Date().toISOString(),
      });
    }
    this.builder.setJournal(this.journal);

    // scope.concurrency is already clamped to [1, SCOPE_HARD_LIMITS.maxConcurrency]
    // by CaptureManager.clampScope(); Math.max(1, ...) is just defense in
    // depth against a resumed capture's older/unclamped scope.
    const workerCount = Math.max(1, this.scope.concurrency);
    this.createViews(workerCount);
    this.state = 'running';

    if (!this.resumeFrom) {
      await this.enqueue({ url: this.startUrl, depth: 0, discoveredOn: null });
    }
    this.emit();

    let startFinalUrl = this.startUrl;

    try {
      // Each worker runs the same loop body the old single-threaded crawl
      // used to run once, against its own hidden view -- see runWorker()
      // for how they share the queue and builder safely, and how they
      // agree when there's truly nothing left for anyone to do.
      await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) =>
          this.runWorker(workerIndex, startOrigin, (finalUrl) => {
            startFinalUrl = finalUrl;
          }),
        ),
      );

      if (this.cancelled) {
        this.state = 'cancelled';
        await this.builder.addFailure({
          url: this.currentUrl ?? this.startUrl,
          kind: 'cancelled',
          message: 'Capture was cancelled by the user',
          discoveredOn: null,
        });
        this.emitTerminal({ state: 'cancelled' });
        // Cleanup happens in `finally`, after the journal handle is
        // closed. Deleting the staging tree while the journal file inside
        // it is still open can fail (e.g. EBUSY on Windows), and that
        // failure must never be mistaken by the outer catch for a failed
        // capture just because the user asked to cancel -- nothing is
        // written to the final path on cancel, so no previous archive at
        // that path is ever damaged either way.
        throw new CaptureCancelledError();
      }

      this.state = 'finalizing';
      this.currentUrl = null;
      this.emit();

      if (this.degradedScreenshotCount > 0) {
        logger.warn('sitearchive.screenshots_degraded_summary', {
          degraded: this.degradedScreenshotCount,
          pagesCompleted: this.pagesCompleted,
        });
      }

      const { fileSizeBytes, manifest: finalManifest } = await this.builder.finalize({
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
        forumSummary: finalManifest.forumSummary,
      };

      this.state = 'completed';
      this.emitTerminal({ state: 'completed', result });
      return result;
    } catch (err) {
      if (err instanceof CaptureCancelledError) throw err;
      this.state = 'failed';
      // Keep the staging tree: it holds every page captured before the
      // failure, and the journal beside it can turn that into a partial
      // archive or resume the crawl. Discarding it here is exactly the
      // behaviour that made a 151-minute crawl produce nothing.
      this.keepStagingForRecovery = true;
      logger.warn('sitearchive.capture_recoverable', {
        archiveId: this.builder.archiveId,
        stagingDir: this.builder.stagingPath ?? '',
        pagesCompleted: this.pagesCompleted,
      });
      this.emitTerminal({ state: 'failed', error: describe(err) });
      throw err;
    } finally {
      await this.journal?.close().catch(() => {});
      this.journal = null;
      this.builder.setJournal(null);
      if (!this.keepStagingForRecovery) {
        await this.builder.cleanup().catch(() => {});
      }
      this.destroyViews();
    }
  }

  /**
   * Run one worker: pull items off the shared queue, capture them against
   * this worker's own hidden view, and stop only once the queue is empty
   * AND no worker is still busy (a busy worker might be about to discover
   * and enqueue more links -- see the termination check below).
   *
   * Every field this touches that isn't already worker-scoped (the queue,
   * queuedOrDone, the builder, the running counters) is safe to share
   * across concurrent workers: see the field comments on `workers` and
   * `busyWorkers` above, and the in-flight-write guards added to
   * SiteArchiveBuilder.addAsset/addResponse for the one place a real race
   * existed (two workers storing identical content-addressed bytes at
   * once).
   */
  private async runWorker(
    workerIndex: number,
    startOrigin: string,
    onStartPageCaptured: (finalUrl: string) => void,
  ): Promise<void> {
    for (;;) {
      await this.waitIfPaused();
      if (this.cancelled) return;

      if (this.scope.maxTotalBytes !== null && this.builder.totalBytes >= this.scope.maxTotalBytes) {
        logger.info('sitearchive.size_limit_reached', {});
        await this.recordLimitStopOnce('Stopped at the archive size limit');
        return;
      }

      // Disk-space floor, enforced even when every other limit is
      // unlimited -- "no limit" must never mean "fill the user's drive".
      if (!(await hasFreeDiskSpace(app.getPath('temp'), MIN_FREE_DISK_BYTES))) {
        await this.recordLowDiskStopOnce();
        return;
      }

      // Everything from here to `this.pagesInFlight += 1` below is
      // synchronous -- no `await` -- which is what makes this an atomic
      // claim rather than a check-then-act race. Two workers checking
      // `pagesCompleted + pagesInFlight` against maxPages and only THEN
      // claiming a slot (with an await in between, e.g. the disk-space
      // check above) could both pass the check before either claims,
      // exactly like the addAsset race fixed in archiveWriter.ts -- which
      // is what let a 2-worker, maxPages:3 capture complete 4 pages before
      // this existed. A page that fails doesn't become a completed page,
      // so its claimed slot is released in the finally block below,
      // matching the original single-worker behaviour where a failed
      // fetch never counted against the page budget.
      if (this.scope.maxPages !== null && this.pagesCompleted + this.pagesInFlight >= this.scope.maxPages) {
        logger.info('sitearchive.page_limit_reached', { limit: this.scope.maxPages });
        await this.recordLimitStopOnce(`Stopped at the page limit of ${this.scope.maxPages}`);
        return;
      }

      if (this.queue.size === 0) {
        if (this.busyWorkers === 0) return; // nothing queued, nobody could add to it -- genuinely done
        await sleep(WORKER_IDLE_POLL_MS);
        continue;
      }

      const item = this.queue.shift()!;
      this.pagesInFlight += 1;
      this.busyWorkers += 1;
      try {
        this.currentUrl = item.url;
        // Recorded before the attempt, so a crawl resumed after a crash
        // doesn't retry the page that was in flight when it died -- which
        // is also the page most likely to have caused the death.
        const itemNormalized = normalizeUrl(item.url);
        if (itemNormalized) await this.journal?.append({ t: 'deq', norm: itemNormalized });
        this.emit();

        const captured = await this.capturePageSafely(workerIndex, item, startOrigin);
        if (captured?.isStart) onStartPageCaptured(captured.finalUrl);

        await this.journal?.append({
          t: 'stat',
          bytesDownloaded: this.bytesDownloaded,
          warnings: this.warningCount,
          total: this.builder.totalBytes,
          title: this.siteTitle,
        });

        // Periodically rebuild this worker's view so a long, unlimited
        // crawl doesn't accumulate renderer memory until it's killed --
        // or early, if the renderer looks wedged. Counted per worker,
        // since it's that worker's own renderer process whose memory (or
        // wedged-ness) this is about.
        const worker = this.workers[workerIndex]!;
        worker.pagesSinceRecycle += 1;
        const dueForRecycle = worker.pagesSinceRecycle >= PAGES_PER_VIEW_RECYCLE;
        if ((dueForRecycle || worker.forceViewRecycle) && this.queue.size > 0 && !this.cancelled) {
          worker.forceViewRecycle = false;
          worker.pagesSinceRecycle = 0;
          await this.recycleView(workerIndex);
        }
      } finally {
        // Released unconditionally: capturePageSafely already increments
        // pagesCompleted itself on success, so this is a no-op toward the
        // budget for a success (the slot just becomes permanent) and a
        // real release for a failure (the slot becomes claimable again).
        this.pagesInFlight -= 1;
        this.busyWorkers -= 1;
      }

      // Politeness delay between this worker's own page loads -- with N
      // workers each observing it independently, the aggregate request
      // rate scales with concurrency, same as N polite visitors browsing
      // at once rather than one visitor browsing N times faster.
      if (this.scope.crawlDelayMs > 0) {
        await sleep(this.scope.crawlDelayMs);
      }
    }
  }

  /** Only the first worker to notice should record why the crawl stopped early. */
  private async recordLimitStopOnce(reason: string): Promise<void> {
    if (this.stopReasonRecorded) return;
    this.stopReasonRecorded = true;
    await this.recordLimitStop(reason);
  }

  private async recordLowDiskStopOnce(): Promise<void> {
    if (this.stopReasonRecorded) return;
    this.stopReasonRecorded = true;
    logger.warn('sitearchive.stopped_low_disk', {});
    await this.builder.addFailure({
      url: this.currentUrl ?? this.startUrl,
      kind: 'too-large',
      message: 'Capture stopped: the disk is running out of free space.',
      discoveredOn: null,
    });
  }

  /** One hidden view per worker, so crawling never disturbs the user's actual tab. */
  private createViews(count: number): void {
    this.views = [];
    this.workers = [];
    for (let i = 0; i < count; i += 1) {
      this.views.push(this.newView());
      this.workers.push({ consecutiveScreenshotDegradations: 0, forceViewRecycle: false, pagesSinceRecycle: 0 });
    }
  }

  private newView(): WebContentsView {
    const view = new WebContentsView({
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
    this.window.contentView.addChildView(view);
    // A real viewport size so layout and lazy-loading behave normally.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    view.setVisible(false);
    return view;
  }

  /**
   * Tear one worker's view down and build a fresh one.
   *
   * A single renderer navigated through hundreds of media-heavy pages
   * accumulates memory that never comes back (caches, detached documents,
   * JS heap growth), and eventually the process is killed mid-crawl --
   * observed on a real site at ~85 pages. Recycling the view periodically
   * hands that memory back to the OS. The crawl queue and the archive
   * builder live outside any one view, so nothing captured so far is lost.
   *
   * Deliberately does NOT clear `this.session`'s HTTP cache the way the
   * single-worker version used to: the session is shared across every
   * worker (same login/cookies for the whole crawl), so clearing it here
   * would evict other workers' still-useful cached responses and disrupt
   * whatever they currently have in flight, on every one of N workers'
   * independent recycle cadences rather than once for the whole crawl.
   * The renderer-process teardown below is what actually reclaims memory;
   * the cache clear was a secondary, session-wide effect that doesn't
   * belong to one worker to trigger.
   */
  private async recycleView(workerIndex: number): Promise<void> {
    const view = this.views[workerIndex];
    // Sampled on the *old* view right before it's torn down, so this line
    // says how much the renderer had grown to by the time recycling
    // triggered -- the docstring above asserts recycling reclaims that
    // memory, but nothing previously measured whether it actually does.
    const memory = view && !view.webContents.isDestroyed() ? sampleCaptureMemory(view.webContents) : null;
    logger.info('sitearchive.recycling_view', {
      workerIndex,
      pagesCompleted: this.pagesCompleted,
      rendererBytesBeforeRecycle: memory?.rendererBytes ?? null,
      rendererPeakBytesBeforeRecycle: memory?.rendererPeakBytes ?? null,
    });
    this.destroyView(workerIndex);
    // Let the old renderer process actually go away before starting another.
    await sleep(500);
    if (!this.cancelled) this.views[workerIndex] = this.newView();
  }

  private destroyView(workerIndex: number): void {
    const view = this.views[workerIndex];
    if (!view) return;
    try {
      this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      /* window may already be gone */
    }
    this.views[workerIndex] = null;
  }

  private destroyViews(): void {
    for (let i = 0; i < this.views.length; i += 1) this.destroyView(i);
  }

  private async enqueue(item: QueueItem): Promise<void> {
    const normalized = normalizeUrl(item.url);
    if (!normalized) return;
    if (this.queuedOrDone.has(normalized)) return;
    this.queuedOrDone.add(normalized);
    this.queue.push(item);
    this.pagesDiscovered += 1;
    await this.journal?.append({
      t: 'enq',
      url: item.url,
      norm: normalized,
      depth: item.depth,
      on: item.discoveredOn,
    });
  }

  /**
   * Restore queue and counters from a replayed journal.
   *
   * The builder's own state is restored separately; this is the part that
   * lives on the job rather than in the archive.
   */
  private restoreCrawlState(checkpoint: ReplayedCheckpoint): void {
    // Re-pushing in the original enqueue order rebuilds the same buckets;
    // only the rotation cursor restarts, which affects ordering slightly
    // but never which pages are eligible.
    this.queue = new CrawlFrontier();
    for (const q of checkpoint.queue) {
      this.queue.push({ url: q.url, depth: q.depth, discoveredOn: q.discoveredOn });
    }
    this.queuedOrDone = checkpoint.queuedOrDone;
    this.pagesDiscovered = checkpoint.pagesDiscovered;
    this.pagesCompleted = checkpoint.pagesCompleted;
    this.bytesDownloaded = checkpoint.bytesDownloaded;
    this.warningCount = checkpoint.warningCount;
    this.siteTitle = checkpoint.siteTitle;
    for (const f of checkpoint.failures) {
      if (f.kind.startsWith('skipped-')) this.skippedUrls.add(normalizeUrl(f.url) ?? f.url);
    }
    // So the "threads saved" progress counter reflects pre-resume work
    // immediately rather than starting back at zero until new pages land.
    for (const p of checkpoint.pages) {
      if (!p.forumThreadKey) continue;
      const existing = this.forumPageIndexByThreadKey.get(p.forumThreadKey) ?? 0;
      if ((p.forumPageIndex ?? 0) > existing) this.forumPageIndexByThreadKey.set(p.forumThreadKey, p.forumPageIndex ?? existing + 1);
    }
  }

  private async capturePageSafely(
    workerIndex: number,
    item: QueueItem,
    startOrigin: string,
  ): Promise<{ isStart: boolean; finalUrl: string } | null> {
    const view = this.views[workerIndex];
    if (!view || view.webContents.isDestroyed()) return null;

    const normalized = normalizeUrl(item.url);
    if (!normalized) {
      await this.recordFailure({ url: item.url, kind: 'skipped-non-http', message: 'Not an http(s) URL', discoveredOn: item.discoveredOn });
      return null;
    }

    try {
      const loaded = await loadUrl(view.webContents, item.url);
      if (!loaded.ok) {
        await this.recordFailure({
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
        await this.recordFailure({
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
        await this.recordFailure({
          url: item.url,
          kind: 'skipped-scope',
          message: `Redirected out of scope to ${finalUrl}`,
          discoveredOn: item.discoveredOn,
        });
        return null;
      }

      // Let client-rendered content settle before serializing.
      await sleep(600);

      let forumThreadKey: string | undefined;
      let forumSectionKey: string | undefined;
      let forumPageIndex: number | undefined;
      if (isForumScopeKind(this.scope.kind)) {
        const candidateThreadKey = threadKeyOf(finalNormalized);
        // A section's own index page (e.g. /forum/section-1) shares no
        // pagination shape distinguishing it from "a thread with a very
        // plain URL" -- exclude it explicitly so the forum summary's
        // thread count doesn't include the section listing itself.
        const isSectionIndexPage = this.scope.kind === 'forum-section' && candidateThreadKey === this.startSectionKey;
        if (!isSectionIndexPage) {
          forumThreadKey = candidateThreadKey;
          forumPageIndex = (this.forumPageIndexByThreadKey.get(forumThreadKey) ?? 0) + 1;
          this.forumPageIndexByThreadKey.set(forumThreadKey, forumPageIndex);
        }
        forumSectionKey = item.forumSectionKey ?? this.startSectionKey ?? undefined;
      }

      const result = await capturePage(
        view.webContents,
        {
          builder: this.builder,
          session: this.session,
          scope: this.scope,
          startOrigin,
          maxResourceBytes: this.scope.includeMedia ? MAX_RESOURCE_BYTES_WITH_MEDIA : MAX_RESOURCE_BYTES,
          resourceTimeoutMs: RESOURCE_TIMEOUT_MS,
          assetConcurrency: this.scope.includeMedia ? ASSET_CONCURRENCY_WITH_MEDIA : ASSET_CONCURRENCY,
          pageBudgetMs: PAGE_CAPTURE_BUDGET_MS,
        },
        {
          originalUrl: item.url,
          finalUrl,
          normalizedUrl: finalNormalized,
          depth: item.depth,
          redirectedFrom: finalNormalized !== normalized ? [normalized] : [],
          forumThreadKey,
          forumSectionKey,
          forumPageIndex,
        },
      );

      this.pagesCompleted += 1;
      this.bytesDownloaded += result.bytesDownloaded;
      this.warningCount += result.warnings.length;
      if (!this.siteTitle) this.siteTitle = result.title;

      const worker = this.workers[workerIndex]!;
      if (result.screenshotDegraded) {
        this.degradedScreenshotCount += 1;
        worker.consecutiveScreenshotDegradations += 1;
        // Every Nth consecutive failure, not just the first: if the fresh
        // view is wedged too, keep trying rather than giving up silently.
        if (worker.consecutiveScreenshotDegradations % MAX_CONSECUTIVE_SCREENSHOT_DEGRADATIONS === 0) {
          logger.warn('sitearchive.screenshots_degraded_recycling_view', {
            workerIndex,
            consecutive: worker.consecutiveScreenshotDegradations,
            pagesCompleted: this.pagesCompleted,
          });
          worker.forceViewRecycle = true;
        }
      } else {
        worker.consecutiveScreenshotDegradations = 0;
      }

      // Discover further pages, unless we've hit the depth limit. For a
      // forum scope, this check is intentionally skipped: discoverLinks
      // itself decides per-link whether to advance depth (pagination
      // stays at this page's own depth; a genuinely new thread/section
      // costs a slot), so gating the call itself on item.depth < maxDepth
      // would stop even a maxDepth:0 thread capture from ever finding its
      // own page 2 -- the depth check that matters for those links still
      // happens naturally, once each enqueued item is itself dequeued and
      // this same check runs again for it.
      if (isForumScopeKind(this.scope.kind) || this.scope.maxDepth === null || item.depth < this.scope.maxDepth) {
        await this.discoverLinks(result.links, finalUrl, item.depth, startOrigin, forumSectionKey);
      }

      this.emit();
      return { isStart: item.depth === 0, finalUrl };
    } catch (err) {
      await this.recordFailure({
        url: item.url,
        kind: 'render-failed',
        message: describe(err),
        discoveredOn: item.discoveredOn,
      });
      return null;
    }
  }

  private async discoverLinks(
    links: DiscoveredLink[],
    pageUrl: string,
    currentDepth: number,
    startOrigin: string,
    /** For forum-section/forum-whole: the section this page belongs to, if established yet. */
    pageSectionKey?: string,
  ): Promise<void> {
    const isForumScope = isForumScopeKind(this.scope.kind);
    const pageNormalized = normalizeUrl(pageUrl);
    const pageThreadKey = pageNormalized ? threadKeyOf(pageNormalized) : null;

    for (const link of links) {
      if (this.pagesDiscovered >= SCOPE_HARD_LIMITS.maxPages) return;

      const absolute = link.url;
      if (!isHttpUrl(absolute)) continue; // mailto:, tel:, javascript: etc. are never crawled

      // Never follow a link that looks like it performs an action, and
      // never follow links inside forms (they're usually submit-adjacent).
      if (looksDestructive(absolute)) {
        await this.recordSkip({ url: absolute, kind: 'skipped-sensitive', message: 'Link looks like a state-changing action', discoveredOn: pageUrl });
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

      if (isForumScope && !isAllowedByRobots(new URL(absolute).pathname, this.robotsRules)) {
        await this.recordSkip({ url: absolute, kind: 'skipped-non-content', message: 'Disallowed by robots.txt', discoveredOn: pageUrl });
        continue;
      }

      const normalized = normalizeUrl(absolute);
      const isPagination = isForumScope && normalized !== null && looksLikeForumPagination(absolute, link.text);

      // Print/alternate-view duplicates of a page reachable in its normal
      // form are never crawled at all, forum scope or not.
      if (looksLikePrintOrAlternateView(absolute)) {
        await this.recordSkip({ url: absolute, kind: 'skipped-duplicate', message: 'Print/alternate view of a page already reachable normally', discoveredOn: pageUrl });
        continue;
      }

      // Downloadable documents/attachments are captured as assets by the
      // page's own resource-fetch pass (see pageScript.ts/pageCapture.ts),
      // never crawled as pages.
      if (link.download || (isForumScope && looksLikeAttachment(absolute))) {
        if (!link.download && this.scope.forumDownloadAttachments === false) {
          await this.recordSkip({ url: absolute, kind: 'skipped-attachment-excluded', message: 'Attachment downloads are turned off for this capture', discoveredOn: pageUrl });
        }
        continue;
      }

      // Pagination is checked before the generic crawler-trap heuristic --
      // a legitimate `?page=47` on a long thread must never be mistaken
      // for a generated URL permutation. It gets its own, more generous
      // bound instead.
      if (!isPagination && looksLikeCrawlerTrap(absolute)) {
        await this.recordSkip({ url: absolute, kind: 'skipped-trap', message: 'URL matched a crawler-trap heuristic', discoveredOn: pageUrl });
        continue;
      }
      if (isPagination) {
        const hopKey = pageThreadKey ?? pageUrl;
        const hops = (this.paginationHopCounts.get(hopKey) ?? 0) + 1;
        this.paginationHopCounts.set(hopKey, hops);
        if (hops > MAX_PAGINATION_HOPS_PER_UNIT) {
          await this.recordSkip({ url: absolute, kind: 'skipped-trap', message: 'Pagination chain exceeded its bound', discoveredOn: pageUrl });
          continue;
        }
      }

      // Sign-in flows, search endpoints and (unless opted in) member
      // profiles are not archivable content, and on a link-dense site
      // they crowd out the pages the user actually wanted.
      if (looksNonContent(absolute, { includeProfiles: isForumScope && this.scope.forumIncludeProfiles === true })) {
        await this.recordSkip({
          url: absolute,
          kind: 'skipped-non-content',
          message: 'Account, search or navigation route rather than page content',
          discoveredOn: pageUrl,
        });
        continue;
      }

      let childSectionKey = pageSectionKey;
      if (isForumScope && this.scope.kind !== 'forum-thread' && normalized) {
        if (this.scope.kind === 'forum-section') {
          // Narrow scope: only the section's own pagination, or a thread
          // discovered directly from a page inside that section, is in
          // scope. Anything else is deliberately excluded rather than
          // guessed at -- overreaching a "this section only" request
          // would violate the scope the user asked for.
          const linkSectionKey = sectionKeyOf(normalized);
          const onStartSection = pageSectionKey === this.startSectionKey;
          const isSectionPagination = linkSectionKey === this.startSectionKey;
          // "Discovered from the section index" alone isn't enough --
          // that page's global nav links to unrelated parts of the site
          // just as easily as it links to a real thread. Requiring the
          // same leading path segment as the section itself (e.g. both
          // under "/forum") keeps this to forum-shaped links.
          const looksForumShaped = this.forumRootPrefix !== null && leadingPathSegment(normalized) === this.forumRootPrefix;
          const isThreadFromStartSection = onStartSection && !isSectionPagination && looksForumShaped;
          const isThreadPagination = pageThreadKey !== null && isPagination && threadKeyOf(normalized) === pageThreadKey;
          if (!isSectionPagination && !isThreadFromStartSection && !isThreadPagination) {
            await this.recordSkip({ url: absolute, kind: 'skipped-out-of-forum-scope', message: 'Outside the selected forum section', discoveredOn: pageUrl });
            continue;
          }
          childSectionKey = this.startSectionKey ?? undefined;
        } else if (this.scope.kind === 'forum-whole' && pageSectionKey === undefined) {
          // Nothing has established a section yet (we're still at/near
          // the forum root) -- the first page a link is discovered from
          // becomes the working section identity for everything reached
          // through it. A forum that links threads straight from the
          // root without an intermediate section page simply never gets
          // this label, which only affects the section-grouping summary,
          // not what gets captured.
          childSectionKey = pageNormalized ? sectionKeyOf(pageNormalized) : undefined;
        }
      } else if (isForumScope && this.scope.kind === 'forum-thread' && normalized) {
        // Narrowest scope: only pagination of the exact starting thread.
        if (threadKeyOf(normalized) !== this.startThreadKey) {
          await this.recordSkip({ url: absolute, kind: 'skipped-out-of-forum-scope', message: 'Outside the selected thread', discoveredOn: pageUrl });
          continue;
        }
      }

      const nextDepth = isPagination ? currentDepth : currentDepth + 1;
      // For forum scopes the outer maxDepth gate on calling discoverLinks
      // at all is bypassed (see capturePageSafely), specifically so
      // pagination -- which never advances depth -- keeps working at the
      // depth ceiling. A genuinely new (non-pagination) link still has to
      // respect maxDepth, so that check happens here instead, per link,
      // rather than at the call site.
      if (isForumScope && !isPagination && this.scope.maxDepth !== null && nextDepth > this.scope.maxDepth) {
        continue; // beyond the depth limit -- normal, not a failure worth listing
      }
      await this.enqueue({ url: absolute, depth: nextDepth, discoveredOn: pageUrl, forumSectionKey: childSectionKey });
    }
  }

  /**
   * Record that the crawl stopped early because of a scope limit.
   *
   * Without this an archive truncated by its budget is indistinguishable
   * from one that captured the whole site -- which is how a forum capture
   * that reached no threads at all still looked like a success.
   */
  private async recordLimitStop(reason: string): Promise<void> {
    const remaining = this.queue.pending();
    await this.recordFailure({
      url: this.startUrl,
      kind: 'stopped-at-limit',
      message:
        remaining.length > 0
          ? `${reason}; ${remaining.length} discovered page(s) still queued and never captured.`
          : `${reason}.`,
      discoveredOn: null,
    });
  }

  /** Record a per-link skip once, however many pages link to it. */
  private async recordSkip(failure: CaptureFailureEntry): Promise<void> {
    const key = normalizeUrl(failure.url) ?? failure.url;
    if (this.skippedUrls.has(key)) return;
    this.skippedUrls.add(key);
    await this.recordFailure(failure);
  }

  private async recordFailure(failure: CaptureFailureEntry): Promise<void> {
    await this.builder.addFailure(failure);
    this.emit();
  }

}

/**
 * Navigate a hidden view, with a hard timeout and redirect-loop detection.
 * Resolves with ok:false rather than throwing so one bad page never aborts
 * a whole crawl (or retry pass).
 *
 * Exported (not a CaptureJob method) so retryFailedPages.ts can reuse the
 * exact same navigation/timeout/redirect-loop handling instead of a second
 * implementation that could drift from this one.
 */
export function loadUrl(
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

export class CaptureCancelledError extends Error {
  constructor() {
    super('Capture cancelled');
    this.name = 'CaptureCancelledError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when at least `required` bytes remain free. If free space can't be
 * determined we return true rather than blocking the capture -- an
 * unknown-space platform quirk shouldn't stop archiving from working.
 */
async function hasFreeDiskSpace(dir: string, required: number): Promise<boolean> {
  const info = await getDiskSpace(dir);
  if (!info) return true;
  return info.freeBytes > required;
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
