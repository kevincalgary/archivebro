import type { WebContents, Session } from 'electron';
import crypto from 'node:crypto';
import type { SiteArchiveBuilder } from './archiveWriter';
import type { CaptureScope } from '../../shared/sitearchiveTypes';
import { ARCHIVE_SITE_SCHEME } from './constants';
import {
  CLEANUP_LIVE_ATTRS_SCRIPT,
  COLLECT_RESOURCES_SCRIPT,
  EXTRACT_TEXT_SCRIPT,
  GET_SCROLL_SCRIPT,
  LAZY_LOAD_SWEEP_SCRIPT,
  restoreScrollScript,
  serializeDomScript,
} from './pageScript';
import { captureElementScreenshots, unavailableImagePlaceholder, type FallbackCandidate } from './imageFallback';
import { fetchResource } from './resourceFetcher';
import { isDocumentUrl, isMediaUrl, isInScope, normalizeUrl, hostOf } from './urlNormalize';
import { captureFullPageScreenshot } from '../capture/screenshotCapture';
import { sampleCaptureMemory } from '../capture/memoryTelemetry';
import { logger } from '../util/logger';
import { mapWithConcurrency, withDeadline, TIMED_OUT } from '../util/concurrency';

export interface DiscoveredLink {
  url: string;
  text: string;
  rel: string;
  insideForm: boolean;
  download: boolean;
}

export interface PageCaptureResult {
  pageId: string;
  title: string;
  links: DiscoveredLink[];
  bytesDownloaded: number;
  warnings: string[];
  /**
   * True when the full-page screenshot fell back to a viewport crop. The
   * crawler watches this: a run of these means the renderer is wedged, and
   * every page captured meanwhile is quietly missing most of its image.
   */
  screenshotDegraded: boolean;
}

export interface PageCaptureContext {
  builder: SiteArchiveBuilder;
  session: Session;
  scope: CaptureScope;
  startOrigin: string;
  maxResourceBytes: number;
  resourceTimeoutMs: number;
  /** How many subresources of a single page to fetch at once. */
  assetConcurrency: number;
  /**
   * Wall-clock ceiling for capturing one page.
   *
   * Nothing else bounds this. `loadUrl` has its own navigation timeout,
   * and each resource fetch has one, but the capture phases have no
   * collective limit -- so a single pathological page can stall a crawl
   * indefinitely. Measured on a real forum photo thread (116 images, 27
   * dead third-party hosts, heavy ad tags): over 15 minutes for one page,
   * still unfinished. On a site with tens of thousands of pages that is
   * fatal, and the durable fallbacks -- full-page screenshot and extracted
   * text -- are cheap and still captured when the budget runs out.
   */
  pageBudgetMs: number;
}

interface CollectedResources {
  baseUrl: string;
  title: string;
  resources: Array<{ url: string; kind: string; note: string | null }>;
  links: DiscoveredLink[];
}

/**
 * Capture one fully-rendered page into the archive builder:
 * lazy-load sweep -> collect resources -> fetch+store them -> serialize
 * the live DOM with rewritten URLs -> screenshot-fallback any images that
 * could not be fetched -> full-page screenshot + extracted text.
 *
 * The user's scroll position is captured up front and restored at the
 * end, so capturing never leaves the page scrolled somewhere else.
 */
export async function capturePage(
  webContents: WebContents,
  ctx: PageCaptureContext,
  input: { originalUrl: string; finalUrl: string; normalizedUrl: string; depth: number; redirectedFrom: string[] },
): Promise<PageCaptureResult> {
  const warnings: string[] = [];
  let bytesDownloaded = 0;
  let screenshotDegraded = false;
  const pageId = crypto.randomUUID();

  // Phase timings. A single page can take minutes on a link- and
  // image-heavy forum thread, and without this there is no way to tell
  // which phase is responsible -- guessing produced the wrong answer twice.
  const startedAt = Date.now();
  let mark = startedAt;
  const timings: Record<string, number> = {};
  const phase = (name: string) => {
    const now = Date.now();
    timings[name] = now - mark;
    mark = now;
  };
  const deadline = startedAt + ctx.pageBudgetMs;
  const outOfTime = () => Date.now() > deadline;

  // Remember where the user was before we touch the scroll position.
  const originalScroll = (await safeEval<{ x: number; y: number }>(webContents, GET_SCROLL_SCRIPT)) ?? { x: 0, y: 0 };

  try {
    const lazyLoadResult = await withDeadline(safeEval(webContents, LAZY_LOAD_SWEEP_SCRIPT), deadline);
    phase('lazyLoadSweepMs');
    if (lazyLoadResult === TIMED_OUT) {
      warnings.push('Page took too long to settle lazy-loaded content; some images may be missing.');
    }

    const collectedResult = await withDeadline(
      safeEval<CollectedResources>(webContents, COLLECT_RESOURCES_SCRIPT),
      deadline,
    );
    phase('collectResourcesMs');
    if (collectedResult === TIMED_OUT) {
      throw new Error('Could not collect page resources (page time budget exceeded)');
    }
    const collected = collectedResult;
    if (!collected) {
      throw new Error('Could not collect page resources');
    }

    // --- Fetch and store subresources, building the URL rewrite map ---
    const urlMap: Record<string, string> = {};
    const seen = new Set<string>();

    // Decide what to fetch first, so the network work is a flat list we can
    // run in parallel. A real page can reference well over a hundred
    // resources; fetching them one at a time made a single page take tens
    // of seconds on a large site.
    const wanted = collected.resources.filter((resource) => {
      if (seen.has(resource.url)) return false;
      seen.add(resource.url);
      // Respect the user's scope choices for heavy content types.
      if (!ctx.scope.includeMedia && (resource.kind === 'media' || isMediaUrl(resource.url))) return false;
      if (!ctx.scope.includeDocuments && isDocumentUrl(resource.url)) return false;
      return true;
    });

    // Assets may come from a CDN on another host, which is normal and
    // expected -- but only for assets, never for crawled pages.
    // Browsers open several connections per host as a matter of course, so
    // a small bounded pool here is ordinary behaviour rather than
    // aggressive: page-level politeness is still governed by crawlDelayMs.
    const { results: fetched, abandoned, abandonedIndices } = await mapWithConcurrency(
      wanted,
      ctx.assetConcurrency,
      (resource) =>
        fetchResource(resource.url, {
          session: ctx.session,
          maxBytes: ctx.maxResourceBytes,
          timeoutMs: ctx.resourceTimeoutMs,
        }),
      outOfTime,
    );
    if (abandoned > 0) {
      warnings.push(`Page took too long: ${abandoned} resource(s) were not downloaded.`);
    }

    phase('fetchResourcesMs');

    // Apply results in the original order so the archive is byte-stable
    // regardless of the order responses happened to come back in.
    for (let i = 0; i < wanted.length; i += 1) {
      const resource = wanted[i]!;
      const response = fetched[i];

      if (ctx.scope.maxTotalBytes !== null && ctx.builder.totalBytes + bytesDownloaded > ctx.scope.maxTotalBytes) {
        warnings.push('Archive size limit reached; some resources were skipped.');
        break;
      }

      if (!response) {
        // Images that fail here become screenshot-fallback candidates,
        // which the serialize step marks and we handle below. Abandoned
        // (budget ran out before this resource started) is recorded
        // separately from a genuine fetch failure -- conflating the two
        // mislabels every budget casualty as a broken link, and unlike an
        // ordinary failure these are uncapped and can crowd out real ones.
        await ctx.builder.addFailure(
          abandonedIndices.has(i)
            ? {
                url: resource.url,
                kind: 'skipped-budget',
                message: 'Page time budget was exceeded before this resource could be downloaded.',
                discoveredOn: input.finalUrl,
              }
            : {
                url: resource.url,
                kind: 'fetch-failed',
                message: 'Resource could not be downloaded',
                discoveredOn: input.finalUrl,
              },
        );
        continue;
      }

      const asset = await ctx.builder.addAsset(response.body, response.contentType, resource.url);
      bytesDownloaded += response.body.length;
      urlMap[resource.url] = asset.path;

      const normalized = normalizeUrl(resource.url);
      if (normalized) await ctx.builder.routeAsset(normalized, asset.sha256);
    }

    // --- Serialize the rendered DOM with rewritten resource URLs ---
    const archiveOrigin = `${ARCHIVE_SITE_SCHEME}://${ctx.builder.archiveId}`;
    const serializedResult = await withDeadline(
      safeEval<{ html: string; canvasFallbacks: Array<{ marker: string; index: number }> }>(
        webContents,
        serializeDomScript(JSON.stringify(urlMap), archiveOrigin),
      ),
      deadline,
    );
    phase('storeAndSerializeMs');
    if (serializedResult === TIMED_OUT) throw new Error('Could not serialize page DOM (page time budget exceeded)');
    const serialized = serializedResult;
    if (!serialized) throw new Error('Could not serialize page DOM');

    let html = serialized.html;

    // --- Image screenshot fallback for anything that could not be stored ---
    const markers = [...html.matchAll(/data-archive-needs-screenshot="([^"]+)"/g)].map((m) => m[1]!);
    if (markers.length > 0) {
      const candidates: FallbackCandidate[] = markers.map((marker) => {
        const isCanvas = marker.startsWith('archive-canvas-');
        return {
          marker,
          originalUrl: null,
          elementType: isCanvas ? 'canvas' : 'img',
          reason: isCanvas
            ? 'Canvas pixels could not be serialized directly (likely a tainted canvas)'
            : 'Original image resource could not be downloaded',
        };
      });

      const { results, skipped } = await captureElementScreenshots(
        webContents,
        input.finalUrl,
        candidates,
        outOfTime,
      );

      for (const result of results) {
        const asset = await ctx.builder.addAsset(result.png, 'image/png', null, result.meta);
        bytesDownloaded += result.png.length;
        const archiveUrl = `${archiveOrigin}/${asset.path}`;
        // Swap the marked element's src to the screenshot asset. The
        // surrounding <a> (if any) is untouched, so links keep working.
        html = replaceMarkedImage(html, result.marker, archiveUrl);
      }

      for (const skip of skipped) {
        // No usable pixels -- show an explicit placeholder rather than a
        // broken image, so the archive never silently looks wrong.
        html = replaceMarkedWithPlaceholder(html, skip.marker);
        warnings.push(`An image could not be preserved (${skip.reason}).`);
      }
    }

    phase('imageFallbackMs');

    // --- Screenshot + text fallbacks, always available ---
    let screenshot: Buffer | null = null;
    try {
      const shot = await withDeadline(captureFullPageScreenshot(webContents, 90), deadline);
      if (shot === TIMED_OUT) {
        screenshotDegraded = true;
        warnings.push('Full-page screenshot timed out for this page.');
        logger.warn('sitearchive.page_screenshot_timeout', {});
      } else {
        screenshot = shot.png;
        bytesDownloaded += shot.png.length;
        if (shot.kind === 'viewport') {
          screenshotDegraded = true;
          warnings.push('Full-page screenshot failed; only the visible viewport was captured for this page.');
          logger.warn('sitearchive.page_screenshot_viewport_only', { error: shot.reason });
        }
      }
    } catch (err) {
      warnings.push('Full-page screenshot failed for this page.');
      logger.warn('sitearchive.page_screenshot_failed', { error: describe(err) });
    }

    phase('pageScreenshotMs');

    const textResult = await withDeadline(safeEval<string>(webContents, EXTRACT_TEXT_SCRIPT), deadline);
    const text = textResult === TIMED_OUT ? '' : (textResult ?? '');
    phase('extractTextMs');

    await ctx.builder.addPage({
      pageId,
      originalUrl: input.originalUrl,
      finalUrl: input.finalUrl,
      normalizedUrl: input.normalizedUrl,
      title: collected.title || input.finalUrl,
      depth: input.depth,
      html,
      screenshot,
      text,
      redirectedFrom: input.redirectedFrom,
    });

    return {
      pageId,
      title: collected.title || input.finalUrl,
      links: collected.links,
      bytesDownloaded,
      warnings,
      screenshotDegraded,
    };
  } finally {
    // Logged here rather than on the success path: a page that failed or
    // blew its budget is exactly the one whose phase breakdown matters.
    // Sampled every page (the same cadence page_timings already logs at,
    // so this adds fields to an existing line rather than new log volume)
    // so a long crawl that dies leaves a memory trend behind it -- see
    // memoryTelemetry.ts for why both processes are sampled.
    const memory = sampleCaptureMemory(webContents);
    logger.info('sitearchive.page_timings', {
      domain: hostOf(input.finalUrl) ?? '(unparsable)',
      totalMs: Date.now() - startedAt,
      overBudget: Date.now() > deadline,
      ...timings,
      mainRssBytes: memory.mainRssBytes,
      mainHeapUsedBytes: memory.mainHeapUsedBytes,
      rendererBytes: memory.rendererBytes,
      rendererPeakBytes: memory.rendererPeakBytes,
    });

    // Remove the bookkeeping attributes we stamped onto the live page, so
    // capturing leaves the user's page exactly as it was found...
    await safeEval(webContents, CLEANUP_LIVE_ATTRS_SCRIPT).catch(() => null);
    // ...including their scroll position, even if capture failed.
    await safeEval(webContents, restoreScrollScript(originalScroll.x, originalScroll.y)).catch(() => null);
  }
}

/** Replace a screenshot-marked element with an <img> pointing at the asset. */
function replaceMarkedImage(html: string, marker: string, archiveUrl: string): string {
  // Match the single element carrying this marker and rewrite its src,
  // leaving every other attribute (and any wrapping <a>) intact.
  const tagRe = new RegExp(`<(img|canvas)\\b([^>]*?)data-archive-needs-screenshot="${escapeRe(marker)}"([^>]*?)>`, 'i');
  return html.replace(tagRe, (_full, _tag, before: string, after: string) => {
    const attrs = `${before} ${after}`
      .replace(/\ssrc="[^"]*"/i, '')
      .replace(/\sdata-archive-needs-screenshot="[^"]*"/i, '')
      .trim();
    return `<img ${attrs} src="${archiveUrl}" data-archive-rendered-screenshot="true">`;
  });
}

function replaceMarkedWithPlaceholder(html: string, marker: string): string {
  const tagRe = new RegExp(`<(img|canvas)\\b[^>]*?data-archive-needs-screenshot="${escapeRe(marker)}"[^>]*?>`, 'i');
  return html.replace(tagRe, unavailableImagePlaceholder());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function safeEval<T>(webContents: WebContents, script: string): Promise<T | null> {
  try {
    if (webContents.isDestroyed()) return null;
    return (await webContents.executeJavaScript(script, true)) as T;
  } catch (err) {
    logger.warn('sitearchive.script_failed', { error: describe(err) });
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { isInScope };
