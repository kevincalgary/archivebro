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
import { isDocumentUrl, isMediaUrl, isInScope, normalizeUrl } from './urlNormalize';
import { captureFullPageScreenshot } from '../capture/screenshotCapture';
import { logger } from '../util/logger';

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
}

export interface PageCaptureContext {
  builder: SiteArchiveBuilder;
  session: Session;
  scope: CaptureScope;
  startOrigin: string;
  maxResourceBytes: number;
  resourceTimeoutMs: number;
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
  const pageId = crypto.randomUUID();

  // Remember where the user was before we touch the scroll position.
  const originalScroll = (await safeEval<{ x: number; y: number }>(webContents, GET_SCROLL_SCRIPT)) ?? { x: 0, y: 0 };

  try {
    await safeEval(webContents, LAZY_LOAD_SWEEP_SCRIPT);

    const collected = await safeEval<CollectedResources>(webContents, COLLECT_RESOURCES_SCRIPT);
    if (!collected) {
      throw new Error('Could not collect page resources');
    }

    // --- Fetch and store subresources, building the URL rewrite map ---
    const urlMap: Record<string, string> = {};
    const seen = new Set<string>();

    for (const resource of collected.resources) {
      if (seen.has(resource.url)) continue;
      seen.add(resource.url);

      if (ctx.builder.totalBytes + bytesDownloaded > ctx.scope.maxTotalBytes) {
        warnings.push('Archive size limit reached; some resources were skipped.');
        break;
      }

      // Respect the user's scope choices for heavy content types.
      if (!ctx.scope.includeMedia && (resource.kind === 'media' || isMediaUrl(resource.url))) continue;
      if (!ctx.scope.includeDocuments && isDocumentUrl(resource.url)) continue;

      // Assets may come from a CDN on another host, which is normal and
      // expected -- but only for assets, never for crawled pages.
      const fetched = await fetchResource(resource.url, {
        session: ctx.session,
        maxBytes: ctx.maxResourceBytes,
        timeoutMs: ctx.resourceTimeoutMs,
      });

      if (!fetched) {
        // Images that fail here become screenshot-fallback candidates,
        // which the serialize step marks and we handle below.
        ctx.builder.addFailure({
          url: resource.url,
          kind: 'fetch-failed',
          message: 'Resource could not be downloaded',
          discoveredOn: input.finalUrl,
        });
        continue;
      }

      const asset = await ctx.builder.addAsset(fetched.body, fetched.contentType, resource.url);
      bytesDownloaded += fetched.body.length;
      urlMap[resource.url] = asset.path;

      const normalized = normalizeUrl(resource.url);
      if (normalized) ctx.builder.routeAsset(normalized, asset.sha256);
    }

    // --- Serialize the rendered DOM with rewritten resource URLs ---
    const archiveOrigin = `${ARCHIVE_SITE_SCHEME}://${ctx.builder.archiveId}`;
    const serialized = await safeEval<{ html: string; canvasFallbacks: Array<{ marker: string; index: number }> }>(
      webContents,
      serializeDomScript(JSON.stringify(urlMap), archiveOrigin),
    );
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

      const { results, skipped } = await captureElementScreenshots(webContents, input.finalUrl, candidates);

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

    // --- Screenshot + text fallbacks, always available ---
    let screenshot: Buffer | null = null;
    try {
      screenshot = await captureFullPageScreenshot(webContents, 90);
      bytesDownloaded += screenshot.length;
    } catch (err) {
      warnings.push('Full-page screenshot failed for this page.');
      logger.warn('sitearchive.page_screenshot_failed', { error: describe(err) });
    }

    const text = (await safeEval<string>(webContents, EXTRACT_TEXT_SCRIPT)) ?? '';

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

    return { pageId, title: collected.title || input.finalUrl, links: collected.links, bytesDownloaded, warnings };
  } finally {
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
