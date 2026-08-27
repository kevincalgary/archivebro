import { app, type ProcessMetric, type WebContents } from 'electron';
import os from 'node:os';

/**
 * Per-page memory telemetry for a site capture.
 *
 * A real unlimited crawl of landrover.ca ran 151 minutes, saved 810 pages,
 * then the process died with no crash report and nothing logged for the
 * whole run. The archive builder's own in-memory bookkeeping (pages,
 * assets, routes, queuedOrDone, failures) was measured afterwards at ~26MB
 * at that scale -- not the cause -- which leaves the crawling renderer (a
 * separate OS process from Electron's point of view) as the untested
 * suspect. This exists so the *next* long crawl leaves a memory trend
 * behind it, in whichever process turns out to be responsible, instead of
 * requiring a repeat of that manual after-the-fact measurement.
 */

export interface MemorySample {
  /** Main process's own resident/heap memory -- where SiteArchiveBuilder's bookkeeping lives. */
  mainRssBytes: number;
  mainHeapUsedBytes: number;
  /** The crawling renderer's current resident memory, or null if it couldn't be matched. */
  rendererBytes: number | null;
  /** The renderer's peak resident memory since it started, or null. */
  rendererPeakBytes: number | null;
  /**
   * The single GPU process's resident memory, or null if it couldn't be
   * found. Unlike a crawling renderer -- which gets torn down and rebuilt
   * every `PAGES_PER_VIEW_RECYCLE` pages, or sooner on repeated screenshot
   * degradation (see crawler.ts's `recycleView`) -- there is exactly one
   * GPU process for the whole app, shared by every worker's view, and
   * nothing here ever restarts it. Full-page screenshots on a real 151-min
   * crawl degraded permanently after page 346 (464 pages in a row with no
   * recovery, "never recovered across view recycles" -- see Known
   * Limitations) despite renderer recycling happening throughout that run:
   * if the GPU process itself is what degrades under repeated
   * `Page.captureScreenshot` calls for large pages, no renderer recycle
   * would ever show improvement, which matches what was observed. This was
   * never previously measured.
   */
  gpuBytes: number | null;
  gpuPeakBytes: number | null;
  /**
   * Whole-machine free memory (`os.freemem()`), not just this process's own
   * RSS -- the 151-minute crash died with no crash report, which is what a
   * kernel OOM-kill (an unblockable SIGKILL, invisible to any in-process
   * handler) looks like. Per-process RSS alone can't tell "this process
   * grew" apart from "the whole machine was starved by something else
   * entirely" (another renderer, the GPU process, /dev/shm); this can.
   */
  systemFreeBytes: number;
  systemTotalBytes: number;
}

/**
 * Pure lookup, kept separate from `sampleCaptureMemory` so it's testable
 * without a real multi-process Electron app: find the metric entry for a
 * given OS pid among everything `app.getAppMetrics()` returns (browser,
 * GPU, every tab/renderer, utility processes).
 */
export function findRendererMemory(
  metrics: readonly ProcessMetric[],
  rendererPid: number,
): { bytes: number; peakBytes: number } | null {
  const match = metrics.find((m) => m.pid === rendererPid);
  if (!match) return null;
  // MemoryInfo's fields are in KB on every platform Electron reports them for.
  return {
    bytes: match.memory.workingSetSize * 1024,
    peakBytes: match.memory.peakWorkingSetSize * 1024,
  };
}

/**
 * Pure lookup for the app's single GPU process, kept separate from
 * `sampleCaptureMemory` for the same testability reason as
 * `findRendererMemory` above -- no pid needed, since there's only ever one.
 */
export function findGpuProcessMemory(metrics: readonly ProcessMetric[]): { bytes: number; peakBytes: number } | null {
  const match = metrics.find((m) => m.type === 'GPU');
  if (!match) return null;
  return {
    bytes: match.memory.workingSetSize * 1024,
    peakBytes: match.memory.peakWorkingSetSize * 1024,
  };
}

/**
 * Sample memory for the main process, the crawling renderer, and the GPU
 * process right now. Best-effort: a telemetry sample failing (a destroyed
 * webContents, an unavailable metric on some platform) must never abort or
 * even warn during a capture -- it just means this one sample has a null
 * reading for whichever process couldn't be read.
 */
export function sampleCaptureMemory(webContents: WebContents): MemorySample {
  const main = process.memoryUsage();
  let metrics: readonly ProcessMetric[] = [];
  try {
    metrics = app.getAppMetrics();
  } catch {
    metrics = [];
  }
  let renderer: { bytes: number; peakBytes: number } | null = null;
  try {
    if (!webContents.isDestroyed()) {
      renderer = findRendererMemory(metrics, webContents.getOSProcessId());
    }
  } catch {
    renderer = null;
  }
  const gpu = findGpuProcessMemory(metrics);
  return {
    mainRssBytes: main.rss,
    mainHeapUsedBytes: main.heapUsed,
    rendererBytes: renderer?.bytes ?? null,
    rendererPeakBytes: renderer?.peakBytes ?? null,
    gpuBytes: gpu?.bytes ?? null,
    gpuPeakBytes: gpu?.peakBytes ?? null,
    systemFreeBytes: os.freemem(),
    systemTotalBytes: os.totalmem(),
  };
}
