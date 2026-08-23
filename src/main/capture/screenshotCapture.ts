import type { WebContents } from 'electron';
import { logger } from '../util/logger';

/**
 * Full-page (not just viewport) screenshot via the Chrome DevTools
 * Protocol, which is what Electron's own `webContents.debugger` exposes.
 * `webContents.capturePage()` alone only grabs the current viewport, which
 * doesn't satisfy "full-page screenshot" for pages taller than the window.
 */

/**
 * Maximum page area we will attempt to capture, in CSS pixels.
 *
 * These bound how much *content* is captured. They are deliberately not
 * the memory bound -- see the device-pixel budget below, which is what
 * actually governs the size of the bitmap Chromium has to allocate.
 */
const MAX_CAPTURE_HEIGHT = 12_000;
const MAX_CAPTURE_WIDTH = 2_400;

/**
 * Hard ceiling on either dimension of the rasterized bitmap, in DEVICE
 * pixels.
 *
 * Chromium cannot produce a texture larger than 16384px in one dimension;
 * asking for one fails the whole capture with "Unable to capture
 * screenshot". This is the single most important limit here, because the
 * numbers above are CSS pixels and the raster happens at the display's
 * device pixel ratio -- on a 2x display a 12,000px-tall page is a
 * 24,000px-tall texture, which is over the limit and always fails.
 */
const MAX_TEXTURE_DIM = 16_000;

/**
 * Ceiling on total rasterized DEVICE pixels, which is the real bound on
 * peak memory per shot: at 4 bytes per pixel this is ~128 MB for the raw
 * bitmap, before PNG encoding.
 *
 * This budget must be expressed in device pixels rather than CSS pixels.
 * A CSS-pixel budget silently permits dpr^2 times as much memory -- 4x on
 * an ordinary Retina display -- which defeats the point of having it.
 */
const MAX_CAPTURE_DEVICE_PIXELS = 32_000_000;

/** Largest device pixel ratio worth rasterizing at. */
const MAX_DEVICE_SCALE_FACTOR = 3;

export interface FullPageScreenshot {
  png: Buffer;
  /**
   * `viewport` means the full-page path failed and this is a
   * viewport-sized crop instead. Callers must surface this rather than
   * treating it as an ordinary success -- a silent downgrade here is
   * indistinguishable from a correct capture in the resulting archive.
   */
  kind: 'full-page' | 'viewport';
  /** Why the full-page path was abandoned, when `kind` is `viewport`. */
  reason: string | null;
  widthPx: number;
  heightPx: number;
}

/**
 * The ratio the page will actually be rasterized at.
 *
 * Read from the page rather than assumed, and passed back to Chromium
 * explicitly, so the budget arithmetic below is authoritative instead of
 * being silently multiplied by whatever the host display happens to be.
 * (`deviceScaleFactor: 0` means "use the host's", which is exactly the
 * unknown we need to eliminate.)
 */
async function resolveDeviceScaleFactor(webContents: WebContents): Promise<number> {
  try {
    const dpr: unknown = await webContents.executeJavaScript('window.devicePixelRatio', true);
    if (typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0) {
      return Math.min(dpr, MAX_DEVICE_SCALE_FACTOR);
    }
  } catch {
    // Page may be mid-navigation or destroyed; fall through.
  }
  // Assume 1 rather than guessing high: over-estimating the ratio only
  // costs resolution, but under-estimating it would blow the memory bound.
  return 1;
}

/**
 * Fit a CSS-pixel capture region into the device-pixel limits.
 *
 * The rasterized bitmap is `width * scale * dsf` by `height * scale * dsf`,
 * so every limit has to be divided through by `dsf` before it can be
 * compared against a CSS-pixel dimension.
 */
export function fitCaptureToBudget(input: {
  cssWidth: number;
  cssHeight: number;
  deviceScaleFactor: number;
}): { width: number; height: number; scale: number; deviceWidth: number; deviceHeight: number } {
  const dsf = Math.max(1, input.deviceScaleFactor);
  const width = Math.max(1, Math.min(Math.ceil(input.cssWidth), MAX_CAPTURE_WIDTH));
  const height = Math.max(1, Math.min(Math.ceil(input.cssHeight), MAX_CAPTURE_HEIGHT));

  const exact = Math.min(
    1,
    MAX_TEXTURE_DIM / (height * dsf),
    MAX_TEXTURE_DIM / (width * dsf),
    Math.sqrt(MAX_CAPTURE_DEVICE_PIXELS / (width * height * dsf * dsf)),
  );

  // Round the scale *down*. Chromium rounds each output dimension to a
  // whole pixel, so a scale sitting exactly on the area budget can round
  // up twice and land fractionally over it.
  const scale = Math.max(0.01, Math.floor(exact * 1000) / 1000);

  return {
    width,
    height,
    scale,
    deviceWidth: Math.round(width * scale * dsf),
    deviceHeight: Math.round(height * scale * dsf),
  };
}

export async function captureFullPageScreenshot(
  webContents: WebContents,
  _screenshotQuality: number,
): Promise<FullPageScreenshot> {
  const dbg = webContents.debugger;
  const wasAttached = dbg.isAttached();
  if (!wasAttached) dbg.attach('1.3');

  let overrodeMetrics = false;

  try {
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number };
      contentSize: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;

    const deviceScaleFactor = await resolveDeviceScaleFactor(webContents);
    const fit = fitCaptureToBudget({
      cssWidth: size.width,
      cssHeight: size.height,
      deviceScaleFactor,
    });

    if (Math.ceil(size.height) > fit.height) {
      logger.info('screenshot.truncated_tall_page', {
        actualHeight: Math.ceil(size.height),
        capturedHeight: fit.height,
        deviceScaleFactor,
        scale: Number(fit.scale.toFixed(3)),
      });
    }

    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: fit.width,
      height: fit.height,
      // Explicit, not 0: the budget above is only correct if we control this.
      deviceScaleFactor,
      mobile: false,
    });
    overrodeMetrics = true;

    const result = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: fit.width, height: fit.height, scale: fit.scale },
    })) as { data?: string };

    if (result?.data) {
      return {
        png: Buffer.from(result.data, 'base64'),
        kind: 'full-page',
        reason: null,
        widthPx: fit.deviceWidth,
        heightPx: fit.deviceHeight,
      };
    }
    throw new Error('captureScreenshot returned no data');
  } catch (err) {
    // A full-page capture can still fail on pathological pages. A
    // viewport-sized screenshot is a much better outcome than none, so
    // fall back to one rather than losing the visual record entirely --
    // but report the downgrade, because an archive full of viewport crops
    // that claims to hold full-page screenshots is a silent data problem.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('screenshot.fullpage_failed_using_viewport', { error: reason });
    try {
      if (overrodeMetrics) {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
        overrodeMetrics = false;
      }
      const image = await webContents.capturePage();
      const png = image.toPNG();
      if (png.length > 0) {
        const size = image.getSize();
        return { png, kind: 'viewport', reason, widthPx: size.width, heightPx: size.height };
      }
    } catch {
      // fall through to the original failure
    }
    throw err;
  } finally {
    if (overrodeMetrics) {
      try {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
      } catch {
        // webContents may be gone
      }
    }
    if (!wasAttached) {
      try {
        dbg.detach();
      } catch {
        // already detached (e.g. webContents was destroyed mid-capture)
      }
    }
  }
}
