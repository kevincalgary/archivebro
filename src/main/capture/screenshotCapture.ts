import type { WebContents } from 'electron';

/**
 * Full-page (not just viewport) screenshot via the Chrome DevTools
 * Protocol, which is what Electron's own `webContents.debugger` exposes.
 * `webContents.capturePage()` alone only grabs the current viewport, which
 * doesn't satisfy "full-page screenshot" for pages taller than the window.
 */
export async function captureFullPageScreenshot(
  webContents: WebContents,
  _screenshotQuality: number,
): Promise<Buffer> {
  const dbg = webContents.debugger;
  const wasAttached = dbg.isAttached();
  if (!wasAttached) dbg.attach('1.3');

  try {
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number };
      contentSize: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.max(1, Math.ceil(size.width));
    const height = Math.max(1, Math.min(Math.ceil(size.height), 32766)); // Chromium's max texture dimension safety cap

    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });

    const result = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
      quality: undefined, // PNG ignores quality; kept as a documented parameter for a future JPEG mode
    })) as { data: string };

    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
    return Buffer.from(result.data, 'base64');
  } finally {
    if (!wasAttached) {
      try {
        dbg.detach();
      } catch {
        // already detached (e.g. webContents was destroyed mid-capture)
      }
    }
  }
}
