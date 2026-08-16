import { BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { applyTrustedCsp } from '../security/csp';
import { isSafeExternalUrl } from '../browser/urlUtils';
import { logger } from '../util/logger';

const RENDERER_DEV_URL = process.env.ARCHIVE_BROWSER_VITE_URL;

export function createMainWindow(): BrowserWindow {
  // The trusted chrome uses Electron's default session -- deliberately
  // *not* 'persist:browsing' or the offline session -- so cookies/storage
  // from browsed or archived sites can never bleed into the app UI.
  applyTrustedCsp(session.defaultSession);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'trusted-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // The trusted window must never be navigated away from our own UI --
  // this is the last line of defense in case something (a bug, a
  // misbehaving link somehow reaching the chrome webContents) tries to.
  win.webContents.on('will-navigate', (event, url) => {
    const isOwnApp = RENDERER_DEV_URL ? url.startsWith(RENDERER_DEV_URL) : url.startsWith('file://');
    if (!isOwnApp) {
      event.preventDefault();
      logger.warn('trusted_window.navigation_blocked', {});
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => win.show());

  return win;
}
