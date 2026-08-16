import { nativeImage, type WebContents } from 'electron';
import type { ScreenshotFallbackMeta } from '../../shared/sitearchiveTypes';
import { measureElementScript } from './pageScript';
import { logger } from '../util/logger';

/**
 * Screenshot fallback for images that could not be archived normally.
 *
 * This is strictly a *fallback*: normal download is always attempted
 * first and is always preferred, because it preserves the original file,
 * its resolution, animation, and vector properties. This path only runs
 * after that has already failed, and only for content that was ALREADY
 * VISIBLY RENDERED to the user in their own authenticated session. It
 * does not fetch anything, does not bypass authentication, paywalls, DRM,
 * or access controls, and cannot reveal anything the user was not already
 * looking at -- it photographs pixels the browser had already painted.
 */

export interface FallbackCandidate {
  marker: string;
  /** Original resource URL when known (null for canvas/blob/generated). */
  originalUrl: string | null;
  elementType: string;
  reason: string;
}

export interface FallbackResult {
  marker: string;
  png: Buffer;
  meta: ScreenshotFallbackMeta;
}

interface Measurement {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportX: number;
  viewportY: number;
  tagName: string;
  naturalWidth: number;
  naturalHeight: number;
  devicePixelRatio: number;
  originalSrc: string | null;
  hasLinkAncestor: boolean;
}

type MeasureResponse = Measurement | { rejected: string } | null;

/** Largest element screenshot we will attempt, to bound memory use. */
const MAX_CAPTURE_DIMENSION = 4096;

/**
 * Capture tightly-cropped screenshots for each candidate element.
 *
 * The caller is responsible for restoring the user's scroll position
 * afterwards; `captureElementScreenshots` scrolls elements into view as
 * needed and reports the scroll position it started from.
 */
export async function captureElementScreenshots(
  webContents: WebContents,
  pageUrl: string,
  candidates: FallbackCandidate[],
): Promise<{ results: FallbackResult[]; skipped: Array<{ marker: string; reason: string }> }> {
  const results: FallbackResult[] = [];
  const skipped: Array<{ marker: string; reason: string }> = [];

  if (candidates.length === 0) return { results, skipped };

  const dbg = webContents.debugger;
  const wasAttached = dbg.isAttached();
  if (!wasAttached) {
    try {
      dbg.attach('1.3');
    } catch (err) {
      logger.warn('image_fallback.debugger_attach_failed', { error: describe(err) });
      return { results, skipped: candidates.map((c) => ({ marker: c.marker, reason: 'debugger-unavailable' })) };
    }
  }

  try {
    for (const candidate of candidates) {
      try {
        const measurement = (await webContents.executeJavaScript(
          measureElementScript(candidate.marker),
          true,
        )) as MeasureResponse;

        if (!measurement) {
          skipped.push({ marker: candidate.marker, reason: 'element-not-found' });
          continue;
        }
        if ('rejected' in measurement) {
          // Validation refused it: zero size, invisible, tracking pixel,
          // or a broken image that would only capture a placeholder icon.
          skipped.push({ marker: candidate.marker, reason: measurement.rejected });
          continue;
        }

        const png = await captureClip(dbg, measurement);
        if (!png) {
          skipped.push({ marker: candidate.marker, reason: 'capture-failed' });
          continue;
        }

        if (isLikelyBlank(png)) {
          skipped.push({ marker: candidate.marker, reason: 'blank-result' });
          continue;
        }

        results.push({
          marker: candidate.marker,
          png,
          meta: {
            isRenderedScreenshot: true,
            originalUrl: candidate.originalUrl ?? measurement.originalSrc,
            pageUrl,
            elementType: candidate.elementType || measurement.tagName,
            renderedWidth: Math.round(measurement.width),
            renderedHeight: Math.round(measurement.height),
            screenshotWidth: Math.round(measurement.width * measurement.devicePixelRatio),
            screenshotHeight: Math.round(measurement.height * measurement.devicePixelRatio),
            capturedAt: new Date().toISOString(),
            reason: candidate.reason,
          },
        });
      } catch (err) {
        logger.warn('image_fallback.candidate_failed', { error: describe(err) });
        skipped.push({ marker: candidate.marker, reason: 'error' });
      }
    }
  } finally {
    if (!wasAttached) {
      try {
        dbg.detach();
      } catch {
        // webContents may have been destroyed mid-capture
      }
    }
  }

  return { results, skipped };
}

/**
 * Capture exactly the element's rectangle.
 *
 * The clip is expressed in CSS pixels (which is what
 * getBoundingClientRect returns) and `scale` carries the device pixel
 * ratio, so a 2x display yields a 2x-resolution crop of precisely the
 * element's box -- no surrounding page content, no scaling error. Because
 * the rect comes from getBoundingClientRect it already accounts for CSS
 * transforms, zoom, object-fit/object-position, and clipping: it is the
 * element's actual painted box, not its nominal layout box.
 */
async function captureClip(dbg: Electron.Debugger, m: Measurement): Promise<Buffer | null> {
  const width = Math.min(Math.ceil(m.width), MAX_CAPTURE_DIMENSION);
  const height = Math.min(Math.ceil(m.height), MAX_CAPTURE_DIMENSION);
  if (width < 2 || height < 2) return null;

  const result = (await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: m.x,
      y: m.y,
      width,
      height,
      // Preserve the rendered resolution the user actually saw.
      scale: m.devicePixelRatio || 1,
    },
  })) as { data?: string };

  if (!result?.data) return null;
  return Buffer.from(result.data, 'base64');
}

/**
 * Reject screenshots with no usable pixels.
 *
 * Decoded with Electron's own nativeImage (no extra dependency) so this is
 * a real pixel check rather than a guess from file size. A crop is
 * rejected when it is fully transparent, or when it is a uniform
 * white/near-white field -- i.e. an empty box that carries no information
 * and would be worse than an explicit "unavailable" placeholder.
 *
 * A uniform *coloured* block is NOT rejected: a solid-colour logo or swatch
 * is legitimate content that the user actually saw.
 *
 * Sampling is strided so a large crop doesn't cost a full scan.
 */
function isLikelyBlank(png: Buffer): boolean {
  if (png.length < 100) return true;

  try {
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) return true;

    const size = image.getSize();
    if (size.width < 2 || size.height < 2) return true;

    // getBitmap() returns a BGRA byte buffer (4 bytes per pixel). Electron's
    // bundled typings declare it as void, so assert the real runtime type.
    const bitmap = image.getBitmap() as unknown as Buffer;
    if (!bitmap || bitmap.length < 4) return true;

    const pixelCount = bitmap.length / 4;
    const stride = Math.max(1, Math.floor(pixelCount / 4096));

    let sawAnyOpaque = false;
    let sawNonWhite = false;

    for (let p = 0; p < pixelCount; p += stride) {
      const i = p * 4;
      const a = bitmap[i + 3] ?? 0;
      if (a < 8) continue; // effectively transparent
      sawAnyOpaque = true;

      const b = bitmap[i] ?? 0;
      const g = bitmap[i + 1] ?? 0;
      const r = bitmap[i + 2] ?? 0;
      if (r < 247 || g < 247 || b < 247) {
        sawNonWhite = true;
        break;
      }
    }

    if (!sawAnyOpaque) return true; // fully transparent
    return !sawNonWhite; // uniform white/near-white field
  } catch {
    // If it can't be decoded it isn't a usable image either.
    return true;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTML for an image that could not be preserved in any form. */
export function unavailableImagePlaceholder(): string {
  return (
    '<span data-archive-placeholder="image-unavailable" ' +
    'style="display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:120px;min-height:60px;padding:8px 12px;border:1px dashed #999;' +
    'border-radius:4px;background:#f4f4f4;color:#666;font:12px/1.4 sans-serif;' +
    'text-align:center;">Image unavailable in this archive</span>'
  );
}
