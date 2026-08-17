import type { WebContents } from 'electron';
import { logger } from '../util/logger';

/**
 * Full-page (not just viewport) screenshot via the Chrome DevTools
 * Protocol, which is what Electron's own `webContents.debugger` exposes.
 * `webContents.capturePage()` alone only grabs the current viewport, which
 * doesn't satisfy "full-page screenshot" for pages taller than the window.
 */

/**
 * Maximum height we will attempt to rasterize, in CSS pixels.
 *
 * Chromium's hard texture limit is far higher, but real marketing pages
 * are frequently 20,000-40,000px tall and asking the compositor for a
 * single bitmap that size reliably fails ("Unable to capture screenshot")
 * and burns a lot of memory doing so. Capping the height means very long
 * pages are captured from the top down to this limit rather than not at
 * all -- a truncated screenshot is far more useful than none, and the
 * extracted text still covers the whole page.
 */
const MAX_CAPTURE_HEIGHT = 12_000;
const MAX_CAPTURE_WIDTH = 2_400;
/** Ceiling on total rasterized pixels, to bound peak memory per shot. */
const MAX_CAPTURE_PIXELS = 20_000_000;

export async function captureFullPageScreenshot(
  webContents: WebContents,
  _screenshotQuality: number,
): Promise<Buffer> {
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

    const width = Math.max(1, Math.min(Math.ceil(size.width), MAX_CAPTURE_WIDTH));
    let height = Math.max(1, Math.min(Math.ceil(size.height), MAX_CAPTURE_HEIGHT));

    // Scale down rather than refuse, if the page is still too big by area.
    let scale = 1;
    const pixels = width * height;
    if (pixels > MAX_CAPTURE_PIXELS) {
      scale = Math.max(0.25, Math.sqrt(MAX_CAPTURE_PIXELS / pixels));
    }

    if (Math.ceil(size.height) > MAX_CAPTURE_HEIGHT) {
      logger.info('screenshot.truncated_tall_page', {
        actualHeight: Math.ceil(size.height),
        capturedHeight: height,
      });
    }

    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    overrodeMetrics = true;

    const result = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    })) as { data?: string };

    if (result?.data) return Buffer.from(result.data, 'base64');
    throw new Error('captureScreenshot returned no data');
  } catch (err) {
    // A full-page capture can still fail on pathological pages. A
    // viewport-sized screenshot is a much better outcome than none, so
    // fall back to one rather than losing the visual record entirely.
    logger.warn('screenshot.fullpage_failed_using_viewport', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      if (overrodeMetrics) {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
        overrodeMetrics = false;
      }
      const image = await webContents.capturePage();
      const png = image.toPNG();
      if (png.length > 0) return png;
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
