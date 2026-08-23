import { app, session, BrowserWindow } from 'electron';
import path from 'node:path';
import { initLogger, logger, redactUrl, setDiagnosticLogging } from './util/logger';
import { openDatabase, closeDatabase } from './db/database';
import { ArchiveRepo } from './db/archiveRepo';
import { SettingsStore } from './settings/settingsStore';
import { CaptureService } from './capture/captureService';
import { TabManager } from './browser/tabManager';
import { createMainWindow } from './windows/mainWindow';
import { buildAppMenu } from './windows/appMenu';
import { registerIpcHandlers } from './ipc/handlers';
import { registerArchiveSchemeAsPrivileged, registerArchiveProtocolHandler, expectedHashLookup } from './offline/offlineProtocol';
import { recoverFromInterruptedCaptures } from './capture/recovery';
import { enforceStoragePolicies } from './settings/storageManager';
import { Channels } from '../shared/ipcContract';
import { installTestHooks } from './testHooks';
import { CaptureManager } from './sitearchive/captureManager';
import { listRecoverableCaptures, sweepSiteArchiveStaging } from './sitearchive/archiveWriter';
import { registerArchiveSiteSchemeAsPrivileged, closeAllOpenedArchives } from './sitearchive/sitearchiveSession';
import { setPermissionPromptEmitter, denyAllPendingPermissions } from './security/permissionPrompts';
import { SITEARCHIVE_EXTENSION } from '../shared/sitearchiveTypes';

// Must run before app.whenReady().
registerArchiveSchemeAsPrivileged();
registerArchiveSiteSchemeAsPrivileged();

/**
 * .sitearchive files opened by double-clicking arrive differently per OS:
 * macOS fires 'open-file' (possibly before the app is ready), while
 * Windows/Linux pass the path in argv. Both funnel into this queue, which
 * is drained once the window exists.
 */
const pendingArchiveOpens: string[] = [];
let openArchiveFile: ((filePath: string) => void) | null = null;

function queueArchiveOpen(filePath: string): void {
  if (!filePath.toLowerCase().endsWith(`.${SITEARCHIVE_EXTENSION}`)) return;
  if (openArchiveFile) openArchiveFile(filePath);
  else pendingArchiveOpens.push(filePath);
}

function archivePathsFromArgv(argv: string[]): string[] {
  return argv.filter((a) => a.toLowerCase().endsWith(`.${SITEARCHIVE_EXTENSION}`));
}

// macOS: must be registered as early as possible to catch a launch-open.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueArchiveOpen(filePath);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Windows/Linux: a second launch (e.g. double-clicking another archive)
  // forwards its argv here instead of starting a new process.
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    for (const p of archivePathsFromArgv(argv)) queueArchiveOpen(p);
  });

  for (const p of archivePathsFromArgv(process.argv.slice(1))) queueArchiveOpen(p);

  void app.whenReady().then(main);
}

let storageInterval: ReturnType<typeof setInterval> | null = null;

async function main(): Promise<void> {
  initLogger();
  logger.info('app.starting', { version: app.getVersion(), platform: process.platform });

  const settings = new SettingsStore();
  // Honour the user's saved choice rather than forcing it off.
  setDiagnosticLogging(settings.get().diagnosticLogging);

  const dbPath = path.join(app.getPath('userData'), 'archive-browser.sqlite3');
  const db = openDatabase(dbPath);
  const archiveRepo = new ArchiveRepo(db);

  await recoverFromInterruptedCaptures(archiveRepo, settings.get().archiveStorageDir);
  // A capture killed mid-crawl leaves gigabytes in the OS temp directory
  // that nothing else ever reclaims. Checkpointed trees are spared -- they
  // hold work the user can still finish or resume. Both of these walk
  // every staging tree under the temp root, which is slow with several
  // leaked directories present (a real run left six, totalling 3.8 GB) --
  // run them in the background rather than blocking window creation on
  // temp-directory housekeeping the user can't see.
  void (async () => {
    await sweepSiteArchiveStaging(app.getPath('temp')).catch(() => undefined);
    for (const recoverable of await listRecoverableCaptures(app.getPath('temp')).catch(() => [])) {
      logger.info('sitearchive.recoverable_capture_found', {
        archiveId: recoverable.meta.archiveId,
        domain: redactUrl(recoverable.meta.startUrl),
        bytesOnDisk: recoverable.bytesOnDisk,
      });
    }
  })();

  // Library thumbnails in the trusted UI load through archive:// too,
  // rather than granting the trusted window raw file:// access to the
  // archives directory.
  registerArchiveProtocolHandler(session.defaultSession, () => settings.get().archiveStorageDir, expectedHashLookup(archiveRepo));

  const mainWindow = createMainWindow();
  const captureService = new CaptureService(archiveRepo, settings);
  const tabManager = new TabManager(mainWindow, settings, captureService);
  const captureManager = new CaptureManager();

  registerIpcHandlers({ mainWindow, tabManager, settings, archiveRepo, captureManager });
  buildAppMenu(mainWindow, tabManager);
  installTestHooks({ archiveRepo, settings, tabManager, captureManager });

  // Route "ask" permission requests to the trusted UI. If the window is
  // gone there is nothing to ask, and permissionPrompts denies rather than
  // leaving the page waiting.
  setPermissionPromptEmitter((request) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onPermissionRequest, request);
  });
  mainWindow.on('closed', () => {
    setPermissionPromptEmitter(null);
    denyAllPendingPermissions();
  });

  captureManager.onProgress((progress) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onSiteCaptureProgress, progress);
  });

  // An archived page can't use IPC, so "Open Live Version" and external
  // links surface here and are routed through the confirming handlers.
  tabManager.onSiteArchiveOpenLive((url) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'open-live', url });
    }
  });
  tabManager.onSiteArchiveExternalLink((url) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'external', url });
    }
  });

  // Drain any .sitearchive double-click that arrived before we were ready.
  openArchiveFile = (filePath) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'open-archive', path: filePath });
    }
  };
  mainWindow.webContents.once('did-finish-load', () => {
    for (const p of pendingArchiveOpens.splice(0)) openArchiveFile?.(p);
  });

  // Push tab-state and capture-status updates to the renderer as they happen.
  tabManager.onTabState((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onTabState, state);
  });
  tabManager.onTabClosed((tabId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onTabClosed, tabId);
  });
  tabManager.onTabActivated((tabId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onTabActivated, tabId);
  });
  captureService.onCaptureStatus((tabId, status, archiveId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onCaptureStatus, { tabId, status, archiveId });
  });

  // Storage policies (retention / max disk usage) are opt-in and only take
  // effect if configured; see storageManager.ts. Run once at startup and
  // then periodically so a long-running session doesn't silently exceed a
  // configured quota only to be caught at next launch.
  void enforceStoragePolicies(archiveRepo, settings);
  storageInterval = setInterval(() => void enforceStoragePolicies(archiveRepo, settings), 10 * 60 * 1000);

  const firstTabId = tabManager.createTab(undefined, false);
  tabManager.activateTab(firstTabId);

  // On macOS the convention is that closing the window doesn't quit the
  // app, and the dock icon reopens the same window. TabManager holds a
  // reference to this specific BrowserWindow instance (its WebContentsViews
  // are children of its contentView), so we hide-on-close and show-on-
  // activate rather than destroying and recreating the window, which would
  // leave TabManager pointing at a dead window.
  let isQuitting = false;
  app.on('before-quit', () => {
    isQuitting = true;
  });
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  app.on('activate', () => {
    if (!mainWindow.isDestroyed()) mainWindow.show();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (storageInterval) clearInterval(storageInterval);
    closeDatabase();
    app.quit();
  }
});

app.on('will-quit', () => {
  if (storageInterval) clearInterval(storageInterval);
  closeAllOpenedArchives();
  closeDatabase();
});

process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { error: err.message, stack: err.stack ?? '' });
});
