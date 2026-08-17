import type { BrowserWindow, Session } from 'electron';
import type { CaptureProgress, CaptureResult, CaptureScope } from '../../shared/sitearchiveTypes';
import { SCOPE_HARD_LIMITS } from '../../shared/sitearchiveTypes';
import { CaptureCancelledError, CaptureJob } from './crawler';
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

  async start(input: {
    window: BrowserWindow;
    session: Session;
    startUrl: string;
    scope: CaptureScope;
    outputPath: string;
  }): Promise<{ jobId: string; promise: Promise<CaptureResult | null> }> {
    if (this.activeJob) {
      throw new Error('A capture is already running. Wait for it to finish or cancel it first.');
    }

    const scope = CaptureManager.clampScope(input.scope);
    const job = new CaptureJob(input.window, input.session, input.startUrl, scope, input.outputPath);
    this.activeJob = job;

    job.onProgress((progress) => {
      for (const l of this.listeners) l(progress);
    });

    logger.info('sitearchive.capture_started', {
      jobId: job.jobId,
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
