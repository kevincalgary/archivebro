import { app, session } from 'electron';
import path from 'node:path';
import { initLogger, logger, redactUrl, setDiagnosticLogging } from './util/logger';
import { openDatabase, closeDatabase } from './db/database';
import { ArchiveRepo } from './db/archiveRepo';
import { SettingsStore } from './settings/settingsStore';
import { CaptureService } from './capture/captureService';
import { createAppWindow, type AppWindowDeps } from './windows/appWindow';
import { buildAppMenu } from './windows/appMenu';
import { registerIpcHandlers } from './ipc/handlers';
import { registerArchiveSchemeAsPrivileged, registerArchiveProtocolHandler, expectedHashLookup } from './offline/offlineProtocol';
import { recoverFromInterruptedCaptures } from './capture/recovery';
import { enforceStoragePolicies } from './settings/storageManager';
import { Channels } from '../shared/ipcContract';
import { installTestHooks } from './testHooks';
import { CaptureManager } from './sitearchive/captureManager';
import { SiteArchiveHistoryRepo } from './sitearchive/siteArchiveHistoryRepo';
import { listRecoverableCaptures, sweepSiteArchiveStaging } from './sitearchive/archiveWriter';
import { registerArchiveSiteSchemeAsPrivileged, closeAllOpenedArchives } from './sitearchive/sitearchiveSession';
import { setPermissionPromptEmitter, denyAllPendingPermissions } from './security/permissionPrompts';
import { SITEARCHIVE_EXTENSION } from '../shared/sitearchiveTypes';
import { UpdateService } from './updates/updateService';
import { destroyCaptureHostWindow } from './windows/captureHostWindow';
import { allEntries, findEntryForTabWebContents, getFocusedEntry } from './windows/windowRegistry';

// Must run before app.whenReady().
registerArchiveSchemeAsPrivileged();
registerArchiveSiteSchemeAsPrivileged();

/**
 * .sitearchive files opened by double-clicking arrive differently per OS:
 * macOS fires 'open-file' (possibly before the app is ready), while
 * Windows/Linux pass the path in argv. Both funnel into this queue, which
 * is drained once at least one window exists.
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
    const entry = getFocusedEntry();
    if (entry) {
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.focus();
    }
    for (const p of archivePathsFromArgv(argv)) queueArchiveOpen(p);
  });

  for (const p of archivePathsFromArgv(process.argv.slice(1))) queueArchiveOpen(p);

  void app.whenReady().then(main);
}

let storageInterval: ReturnType<typeof setInterval> | null = null;
let updateService: UpdateService | null = null;

async function main(): Promise<void> {
  initLogger();
  logger.info('app.starting', { version: app.getVersion(), platform: process.platform });

  const settings = new SettingsStore();
  // Honour the user's saved choice rather than forcing it off.
  setDiagnosticLogging(settings.get().diagnosticLogging);

  const dbPath = path.join(app.getPath('userData'), 'archive-browser.sqlite3');
  const db = openDatabase(dbPath);
  const archiveRepo = new ArchiveRepo(db);
  const siteArchiveHistoryRepo = new SiteArchiveHistoryRepo(db);

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

  const captureService = new CaptureService(archiveRepo, settings);
  const captureManager = new CaptureManager();
  const windowDeps: AppWindowDeps = {
    settings,
    captureService,
    onAllWindowsClosed: () => {
      denyAllPendingPermissions();
      if (process.platform !== 'darwin') {
        if (storageInterval) clearInterval(storageInterval);
        closeDatabase();
        app.quit();
      }
    },
  };

  updateService = new UpdateService(settings);
  updateService.start();

  registerIpcHandlers({ settings, archiveRepo, captureManager, updateService, siteArchiveHistoryRepo });
  buildAppMenu(
    () => createAppWindow(windowDeps),
    () => void updateService?.checkNow(),
  );
  installTestHooks({
    archiveRepo,
    settings,
    captureManager,
    createWindowForTesting: () => void createAppWindow(windowDeps),
  });

  // Route "ask" permission requests to the window that owns the asking
  // tab; falls back to the focused window for the rare case a tab's owner
  // can't be found (e.g. the tab's window closed in the same tick).
  setPermissionPromptEmitter((request, sourceWebContentsId) => {
    const entry = findEntryForTabWebContents(sourceWebContentsId) ?? getFocusedEntry();
    if (entry && !entry.window.isDestroyed()) {
      entry.window.webContents.send(Channels.onPermissionRequest, request);
    }
  });

  // Drain any .sitearchive double-click that arrived before any window
  // existed yet, into whichever window is focused (creating one if every
  // window has since been closed, e.g. a second instance launched on
  // macOS after the user closed all windows but left the app running).
  openArchiveFile = (filePath) => {
    const entry = getFocusedEntry() ?? createAppWindow(windowDeps);
    entry.window.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'open-archive', path: filePath });
  };

  const firstEntry = createAppWindow(windowDeps);
  firstEntry.window.webContents.once('did-finish-load', () => {
    for (const p of pendingArchiveOpens.splice(0)) openArchiveFile?.(p);
  });

  // Storage policies (retention / max disk usage) are opt-in and only take
  // effect if configured; see storageManager.ts. Run once at startup and
  // then periodically so a long-running session doesn't silently exceed a
  // configured quota only to be caught at next launch.
  void enforceStoragePolicies(archiveRepo, settings);
  storageInterval = setInterval(() => void enforceStoragePolicies(archiveRepo, settings), 10 * 60 * 1000);

  // Every window is a real, independently closable BrowserWindow (each
  // with its own TabManager torn down on close -- see appWindow.ts), so
  // there's no need to hide-and-reshow one distinguished window the way a
  // single-window app has to. macOS keeps the app running with zero
  // windows open (dock icon convention); a dock-icon click with none open
  // creates a fresh one.
  app.on('activate', () => {
    if (allEntries().length === 0) createAppWindow(windowDeps);
  });
}

app.on('will-quit', () => {
  if (storageInterval) clearInterval(storageInterval);
  updateService?.stop();
  closeAllOpenedArchives();
  destroyCaptureHostWindow();
  closeDatabase();
});

process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { error: err.message, stack: err.stack ?? '' });
});
