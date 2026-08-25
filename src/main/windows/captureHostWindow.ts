import { BrowserWindow } from 'electron';

/**
 * A window that exists solely to host the WebContentsView instances a
 * running .sitearchive capture renders pages into -- never visible to the
 * user, but NOT created with `show: false`. Before multi-window support,
 * captures borrowed the single chrome window for this; with several
 * independent chrome windows any of which can be closed at any time, a
 * capture needs a host whose lifetime is the app's, not any one window's.
 *
 * `show: false` was tried first and made full-page screenshots hang
 * indefinitely partway through a crawl (confirmed: capture_started and one
 * page's timings logged, then total silence until the test's own timeout
 * tore the app down) -- Chromium's compositor for a BrowserWindow that has
 * never actually been shown doesn't reliably produce frames, which is
 * fatal for exactly the CDP screenshot calls this app already depends on.
 * Showing it off-screen and inactive keeps real compositing running
 * (fixing the hang) while never letting it steal focus or become visible
 * to the user, even briefly.
 *
 * Created lazily on first use and lives until 'will-quit'.
 */
let hostWindow: BrowserWindow | null = null;

export function getCaptureHostWindow(): BrowserWindow {
  if (hostWindow && !hostWindow.isDestroyed()) return hostWindow;
  const win = new BrowserWindow({
    show: false,
    x: -10_000,
    y: -10_000,
    width: 1024,
    height: 768,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // No 'ready-to-show' wait: this window's own webContents never loads a
  // URL (only the child WebContentsViews added later render anything), so
  // that event may never fire for it.
  win.showInactive();
  hostWindow = win;
  return hostWindow;
}

export function destroyCaptureHostWindow(): void {
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
  hostWindow = null;
}
