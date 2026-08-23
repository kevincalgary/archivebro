import type { BrowserWindow, Session } from 'electron';
import type { CaptureProgress, CaptureResult, CaptureScope } from '../../shared/sitearchiveTypes';
import { SCOPE_HARD_LIMITS } from '../../shared/sitearchiveTypes';
import { CaptureCancelledError, CaptureJob } from './crawler';
import { replayCheckpoint } from './captureJournal';
import { logger } from '../util/logger';

/**
 * Owns running capture jobs. Only one capture runs at a time -- crawling
 * renders real pages, so allowing several concurrently would multiply
 * resource use and hammer the target site.
 */
export class CaptureManager {
  private activeJob: CaptureJob | null = null;
  private listeners: Array<(progress: CaptureProgress) => void> = [];

  onProgress(listener: (progress: CaptureProgress) => void): void {
    this.listeners.push(listener);
  }

  get isBusy(): boolean {
    return this.activeJob !== null;
  }

  get activeJobId(): string | null {
    return this.activeJob?.jobId ?? null;
  }

  /**
   * Clamp user-supplied scope to the absolute hard limits.
   *
   * `null` means the user explicitly asked for no limit, so it is passed
   * through untouched -- clamping it would silently re-impose a cap they
   * deliberately removed. Finite values are still clamped so a typo can't
   * turn into an accidental multi-day crawl.
   */
  static clampScope(scope: CaptureScope): CaptureScope {
    const clamp = (value: number | null, min: number, max: number): number | null =>
      value === null ? null : Math.max(min, Math.min(value, max));

    return {
      ...scope,
      maxDepth: clamp(scope.maxDepth, 0, SCOPE_HARD_LIMITS.maxDepth),
      maxPages: clamp(scope.maxPages, 1, SCOPE_HARD_LIMITS.maxPages),
      maxTotalBytes: clamp(scope.maxTotalBytes, 1024 * 1024, SCOPE_HARD_LIMITS.maxTotalBytes),
      concurrency: Math.max(1, Math.min(scope.concurrency, SCOPE_HARD_LIMITS.maxConcurrency)),
      crawlDelayMs: Math.max(0, Math.min(scope.crawlDelayMs, 10_000)),
      allowedDomains: scope.allowedDomains.slice(0, 100),
      includeExternalDomains: scope.includeExternalDomains.slice(0, 100),
    };
  }

  /**
   * Pick an interrupted capture back up where it stopped.
   *
   * The staging tree still holds every page captured before the
   * interruption; the journal beside it restores the bookkeeping, so the
   * crawl continues from the queue rather than starting over.
   */
  async resumeInterrupted(input: {
    window: BrowserWindow;
    session: Session;
    stagingDir: string;
  }): Promise<{ jobId: string; promise: Promise<CaptureResult | null> } | null> {
    const checkpoint = await replayCheckpoint(input.stagingDir);
    if (!checkpoint) return null;

    return this.launch(
      new CaptureJob(
        input.window,
        input.session,
        checkpoint.meta.startUrl,
        checkpoint.meta.scope,
        checkpoint.meta.outputPath,
        { stagingDir: input.stagingDir, checkpoint },
      ),
      checkpoint.meta.scope,
      { resumed: true, pagesAlreadyCaptured: checkpoint.pagesCompleted },
    );
  }

  async start(input: {
    window: BrowserWindow;
    session: Session;
    startUrl: string;
    scope: CaptureScope;
    outputPath: string;
  }): Promise<{ jobId: string; promise: Promise<CaptureResult | null> }> {
    const scope = CaptureManager.clampScope(input.scope);
    return this.launch(new CaptureJob(input.window, input.session, input.startUrl, scope, input.outputPath), scope, {
      resumed: false,
      pagesAlreadyCaptured: 0,
    });
  }

  private launch(
    job: CaptureJob,
    scope: CaptureScope,
    context: { resumed: boolean; pagesAlreadyCaptured: number },
  ): { jobId: string; promise: Promise<CaptureResult | null> } {
    if (this.activeJob) {
      throw new Error('A capture is already running. Wait for it to finish or cancel it first.');
    }

    this.activeJob = job;

    job.onProgress((progress) => {
      for (const l of this.listeners) l(progress);
    });

    // scopeKind/maxPages/maxDepth are exactly the context a postmortem
    // needs when a capture dies with nothing else logged for the whole
    // run (a real 151-minute unlimited crawl did precisely that).
    logger.info('sitearchive.capture_started', {
      jobId: job.jobId,
      resumed: context.resumed,
      pagesAlreadyCaptured: context.pagesAlreadyCaptured,
      scopeKind: scope.kind,
      maxPages: scope.maxPages,
      maxDepth: scope.maxDepth,
    });

    const promise = job
      .run()
      .then((result) => {
        logger.info('sitearchive.capture_completed', { jobId: job.jobId, pages: result.pageCount });
        return result;
      })
      .catch((err: unknown) => {
        if (err instanceof CaptureCancelledError) {
          logger.info('sitearchive.capture_cancelled', { jobId: job.jobId });
          return null;
        }
        logger.error('sitearchive.capture_failed', {
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      })
      .finally(() => {
        this.activeJob = null;
      });

    return { jobId: job.jobId, promise };
  }

  pause(jobId: string): boolean {
    if (this.activeJob?.jobId !== jobId) return false;
    this.activeJob.pause();
    return true;
  }

  resume(jobId: string): boolean {
    if (this.activeJob?.jobId !== jobId) return false;
    this.activeJob.resume();
    return true;
  }

  cancel(jobId: string): boolean {
    if (this.activeJob?.jobId !== jobId) return false;
    this.activeJob.cancel();
    return true;
  }
}
