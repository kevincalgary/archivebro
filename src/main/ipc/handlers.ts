import { app, ipcMain, dialog, shell, session, type IpcMainInvokeEvent, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { promises as fs, existsSync } from 'node:fs';
import { Channels, IpcSchemas } from '../../shared/ipcContract';
import type { TabManager } from '../browser/tabManager';
import type { SettingsStore } from '../settings/settingsStore';
import type { ArchiveRepo } from '../db/archiveRepo';
import { archiveDirFor, archiveFilePaths } from '../util/paths';
import { getOfflineSession } from '../offline/offlineSession';
import { expectedHashLookup, verifyMhtmlIntegrity } from '../offline/offlineProtocol';
import { logger, setDiagnosticLogging } from '../util/logger';
import { resolvePermissionRequest } from '../security/permissionPrompts';
import { canonicalizeUrl } from '../browser/urlUtils';
import { zipArchiveDirectory } from '../util/zipExport';
import { moveArchiveStorage } from '../util/moveStorage';
import type { DiskUsageInfo } from '../../shared/types';
import type { CaptureManager } from '../sitearchive/captureManager';
import { openSiteArchive, SiteArchiveError } from '../sitearchive/archiveReader';
import { registerOpenedArchive, getSiteArchiveSession } from '../sitearchive/sitearchiveSession';
import { suggestArchiveFilename } from '../sitearchive/crawler';
import { isExecutableUrl } from '../sitearchive/urlNormalize';
import { SITEARCHIVE_EXTENSION, type CaptureProgress, type OpenedSiteArchive } from '../../shared/sitearchiveTypes';
import {
  SiteArchiveBuilder,
  discardRecoveredCapture,
  finalizeRecoveredCapture,
  listRecoverableCapturesSummary,
} from '../sitearchive/archiveWriter';
import path from 'node:path';

interface Deps {
  mainWindow: BrowserWindow;
  tabManager: TabManager;
  settings: SettingsStore;
  archiveRepo: ArchiveRepo;
  captureManager: CaptureManager;
}

/**
 * Every handler below is registered for exactly one validated channel.
 * Two checks run before any handler body executes:
 *   1. `event.senderFrame` must belong to the trusted main window's own
 *      webContents -- a browsing or offline WebContentsView can never
 *      reach these handlers because they're never given a preload script
 *      that calls ipcRenderer in the first place, but this is
 *      defense-in-depth in case that ever changes.
 *   2. The arguments are parsed against the channel's zod schema from
 *      ipcContract.ts; malformed calls are rejected before touching disk,
 *      a session, or a webContents.
 */
export function registerIpcHandlers(deps: Deps): void {
  const { mainWindow, tabManager, settings, archiveRepo, captureManager } = deps;

  function handle<C extends keyof typeof IpcSchemas>(
    channel: C,
    fn: (args: z.infer<(typeof IpcSchemas)[C]>, event: IpcMainInvokeEvent) => unknown,
  ): void {
    ipcMain.handle(channel, (event, rawArgs) => {
      if (event.sender.id !== mainWindow.webContents.id) {
        logger.error('ipc.rejected_untrusted_sender', { channel });
        throw new Error('Untrusted IPC sender');
      }
      const schema = IpcSchemas[channel];
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        logger.error('ipc.rejected_invalid_args', { channel, error: parsed.error.message });
        throw new Error(`Invalid arguments for ${channel}`);
      }
      return fn(parsed.data as z.infer<(typeof IpcSchemas)[C]>, event);
    });
  }

  // --- Tabs ---
  handle(Channels.tabsCreate, (args) => tabManager.createTab(args.url, false));
  handle(Channels.tabsCreatePrivate, (args) => tabManager.createTab(args.url, true));
  handle(Channels.tabsClose, (args) => tabManager.closeTab(args.tabId));
  handle(Channels.tabsActivate, (args) => tabManager.activateTab(args.tabId));
  handle(Channels.tabsList, () => tabManager.list());
  handle(Channels.tabsNavigate, (args) => tabManager.navigate(args.tabId, args.input));
  handle(Channels.tabsGoBack, (args) => tabManager.goBack(args.tabId));
  handle(Channels.tabsGoForward, (args) => tabManager.goForward(args.tabId));
  handle(Channels.tabsReload, (args) => tabManager.reload(args.tabId));
  handle(Channels.tabsStop, (args) => tabManager.stop(args.tabId));
  handle(Channels.tabsSetBounds, (args) => tabManager.setContentBounds(args));
  handle(Channels.tabsToggleArchivePaused, (args) => tabManager.setArchivingPaused(args.tabId, args.paused));

  // --- Library ---
  handle(Channels.libraryQuery, (args) => archiveRepo.query(args));
  handle(Channels.libraryGetDetail, (args) => archiveRepo.getById(args.archiveId));
  handle(Channels.libraryGetVersions, (args) => archiveRepo.getVersions(args.canonicalUrl));
  handle(Channels.libraryRename, (args) => archiveRepo.rename(args.archiveId, args.title));
  handle(Channels.libraryTag, (args) => archiveRepo.setTags(args.archiveId, args.tags));

  handle(Channels.libraryDelete, async (args) => {
    const detail = archiveRepo.getById(args.archiveId);
    archiveRepo.softDelete(args.archiveId);
    if (detail) {
      const dir = archiveDirFor(settings.get().archiveStorageDir, args.archiveId);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  handle(Channels.libraryDeleteByDomain, async (args) => {
    const ids = archiveRepo.listIdsByDomain(args.domain);
    const root = settings.get().archiveStorageDir;
    for (const id of ids) {
      archiveRepo.softDelete(id);
      await fs.rm(archiveDirFor(root, id), { recursive: true, force: true }).catch(() => {});
    }
    return { deletedCount: ids.length };
  });

  handle(Channels.libraryExport, async (args) => {
    const detail = archiveRepo.getById(args.archiveId);
    if (!detail) throw new Error('Archive not found');
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${sanitizeFilename(detail.title || detail.domain)}-${args.archiveId.slice(0, 8)}.zip`,
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { exported: false };
    const dir = archiveDirFor(settings.get().archiveStorageDir, args.archiveId);
    await zipArchiveDirectory(dir, result.filePath);
    return { exported: true, path: result.filePath };
  });

  handle(Channels.libraryRevealInFolder, (args) => {
    const dir = archiveDirFor(settings.get().archiveStorageDir, args.archiveId);
    if (existsSync(dir)) shell.showItemInFolder(dir);
    return { dir };
  });

  handle(Channels.libraryOpenOffline, async (args) => {
    const detail = archiveRepo.getById(args.archiveId);
    if (!detail) throw new Error('Archive not found');
    const offlineSession = getOfflineSession(() => settings.get().archiveStorageDir, expectedHashLookup(archiveRepo));
    const mhtmlPath = archiveFilePaths(settings.get().archiveStorageDir, args.archiveId).mhtml;
    const mhtmlVerified = await verifyMhtmlIntegrity(detail.hasMhtml, mhtmlPath, detail.mhtmlSha256, args.archiveId);
    const integrityFailed = detail.hasMhtml && !mhtmlVerified;
    const tabId = tabManager.openOfflineTab(args.archiveId, offlineSession, mhtmlVerified, mhtmlPath, integrityFailed);
    tabManager.activateTab(tabId);
    return tabId;
  });

  handle(Channels.libraryOpenLive, (args) => {
    const detail = archiveRepo.getById(args.archiveId);
    if (!detail) throw new Error('Archive not found');
    const tabId = tabManager.createTab(detail.finalUrl, false);
    tabManager.activateTab(tabId);
    return tabId;
  });

  handle(Channels.libraryFindArchiveForUrl, (args) => {
    return archiveRepo.findMostRecentByCanonicalUrl(canonicalizeUrl(args.url));
  });

  // --- Settings ---
  handle(Channels.settingsGet, () => settings.get());
  handle(Channels.settingsUpdate, (args) => {
    const next = settings.update(args);
    // Take effect immediately, not just on next launch.
    setDiagnosticLogging(next.diagnosticLogging);
    return next;
  });
  handle(Channels.settingsPickStorageDir, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const newDir = result.filePaths[0];
    if (!newDir) return null;
    const oldDir = settings.get().archiveStorageDir;
    await moveArchiveStorage(oldDir, newDir);
    return settings.update({ archiveStorageDir: newDir });
  });
  handle(Channels.settingsClearBrowsingData, async () => {
    const sess = session.fromPartition('persist:browsing');
    await sess.clearStorageData();
    await sess.clearCache();
  });
  handle(Channels.settingsClearArchiveData, async () => {
    const root = settings.get().archiveStorageDir;
    const domains = archiveRepo.listDistinctDomains();
    for (const domain of domains) {
      const ids = archiveRepo.listIdsByDomain(domain);
      for (const id of ids) {
        archiveRepo.softDelete(id);
        await fs.rm(archiveDirFor(root, id), { recursive: true, force: true }).catch(() => {});
      }
    }
  });
  handle(Channels.settingsExport, async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'archive-browser-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { exported: false };
    await fs.writeFile(result.filePath, JSON.stringify(settings.get(), null, 2), 'utf8');
    return { exported: true };
  });
  handle(Channels.settingsImport, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { imported: false };
    const filePath = result.filePaths[0];
    if (!filePath) return { imported: false };
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const parsed = IpcSchemas[Channels.settingsUpdate].safeParse(raw);
    if (!parsed.success) throw new Error('Invalid settings file');
    settings.update(parsed.data);
    return { imported: true };
  });
  handle(Channels.settingsGetDiskUsage, async (): Promise<DiskUsageInfo> => {
    const maxMb = settings.get().maxDiskUsageMb;
    return {
      totalBytes: archiveRepo.totalSizeBytes(),
      archiveCount: archiveRepo.countActive(),
      quotaBytes: maxMb ? maxMb * 1024 * 1024 : null,
    };
  });

  /**
   * The user's answer to a permission prompt. An unknown or already-used
   * requestId resolves nothing, so a stale or forged reply cannot grant a
   * permission that was never requested.
   */
  handle(Channels.permissionRespond, (args) => {
    if (args.remember) {
      // "Always allow/deny for this kind" becomes a standing default, so
      // the user isn't asked again for the same permission.
      settings.update({
        permissionDefaults: {
          ...settings.get().permissionDefaults,
          [args.permissionKind]: args.allow ? 'allow' : 'deny',
        },
      });
    }
    const resolved = resolvePermissionRequest(args.requestId, args.allow);
    return { resolved };
  });

  handle(Channels.downloadsChooseSavePath, async (args) => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: args.suggestedName });
    return result.canceled ? null : result.filePath;
  });

  // --- Portable .sitearchive capture ---

  handle(Channels.siteCaptureEstimate, (args) => {
    const tab = tabManager.getTabInfo(args.tabId);
    if (!tab) throw new Error('Tab not found');
    return {
      url: tab.url,
      title: tab.title,
      host: (() => {
        try {
          return new URL(tab.url).hostname;
        } catch {
          return '';
        }
      })(),
      canCapture: /^https?:/i.test(tab.url),
      isBusy: captureManager.isBusy,
    };
  });

  handle(Channels.siteCaptureStart, async (args) => {
    const tab = tabManager.getTabInfo(args.tabId);
    if (!tab) throw new Error('Tab not found');
    if (!/^https?:/i.test(tab.url)) throw new Error('Only http(s) pages can be captured');
    if (captureManager.isBusy) throw new Error('A capture is already running');

    const suggested = suggestArchiveFilename(tab.url, tab.title);
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Website Archive',
      defaultPath: suggested,
      filters: [{ name: 'Website Archive', extensions: [SITEARCHIVE_EXTENSION] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { started: false };

    let outputPath = saveResult.filePath;
    if (!outputPath.toLowerCase().endsWith(`.${SITEARCHIVE_EXTENSION}`)) {
      outputPath = `${outputPath}.${SITEARCHIVE_EXTENSION}`;
    }

    const { jobId, promise } = await captureManager.start({
      window: mainWindow,
      session: session.fromPartition('persist:browsing'),
      startUrl: tab.url,
      scope: args.scope,
      outputPath,
    });

    // The promise settles asynchronously; progress (including the final
    // completed/failed/cancelled state) reaches the renderer via the
    // capture progress event, so nothing is awaited here.
    void promise.catch(() => {
      /* terminal state already reported through progress events */
    });

    return { started: true, jobId, outputPath };
  });

  handle(Channels.siteCapturePause, (args) => ({ ok: captureManager.pause(args.jobId) }));
  handle(Channels.siteCaptureResume, (args) => ({ ok: captureManager.resume(args.jobId) }));
  handle(Channels.siteCaptureCancel, (args) => ({ ok: captureManager.cancel(args.jobId) }));

  // --- Recovering an interrupted .sitearchive capture ---
  // Every handler below re-derives the staging directory from the given
  // archiveId via SiteArchiveBuilder.stagingDirFor rather than accepting a
  // path from the renderer, so a compromised or buggy renderer can never
  // point a resume/finish/discard at an arbitrary filesystem location.

  handle(Channels.captureRecoveryList, () => listRecoverableCapturesSummary(app.getPath('temp')));

  handle(Channels.captureRecoveryResume, async (args) => {
    if (captureManager.isBusy) return { ok: false };
    const stagingDir = SiteArchiveBuilder.stagingDirFor(app.getPath('temp'), args.archiveId);
    const started = await captureManager.resumeInterrupted({
      window: mainWindow,
      session: session.fromPartition('persist:browsing'),
      stagingDir,
    });
    if (!started) return { ok: false };
    // Progress (including completion) reaches the renderer through the
    // same capture progress event a fresh capture uses, so nothing further
    // is awaited here -- see siteCaptureStart above.
    void started.promise.catch(() => {});
    return { ok: true, jobId: started.jobId };
  });

  handle(Channels.captureRecoveryFinish, async (args) => {
    const stagingDir = SiteArchiveBuilder.stagingDirFor(app.getPath('temp'), args.archiveId);
    const finished = await finalizeRecoveredCapture(stagingDir, app.getVersion());
    if (!finished) return { ok: false };

    // Finishing doesn't run through CaptureJob/CaptureManager -- there's no
    // crawling left to do -- so its result is synthesized as a terminal
    // CaptureProgress and sent through the exact channel a live capture's
    // completion uses. This lets the renderer's existing progress dialog
    // show it (Open Archive / Reveal / Close) without any bespoke "finish
    // result" UI of its own.
    const progress: CaptureProgress = {
      jobId: `recovered-${args.archiveId}`,
      state: 'completed',
      siteTitle: finished.siteTitle,
      startUrl: finished.startUrl,
      scopeKind: finished.scopeKind,
      pagesDiscovered: finished.pageCount,
      pagesCompleted: finished.pageCount,
      currentUrl: null,
      bytesDownloaded: finished.fileSizeBytes,
      warningCount: 0,
      failureCount: finished.failures.length,
      result: {
        archivePath: finished.archivePath,
        pageCount: finished.pageCount,
        assetCount: finished.assetCount,
        fileSizeBytes: finished.fileSizeBytes,
        failures: finished.failures,
      },
    };
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(Channels.onSiteCaptureProgress, progress);
    return { ok: true };
  });

  handle(Channels.captureRecoveryDiscard, async (args) => {
    const stagingDir = SiteArchiveBuilder.stagingDirFor(app.getPath('temp'), args.archiveId);
    const discarded = await discardRecoveredCapture(stagingDir);
    return { discarded };
  });

  // --- Opening .sitearchive files ---

  handle(Channels.siteArchiveOpen, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Website Archive',
      properties: ['openFile'],
      filters: [{ name: 'Website Archive', extensions: [SITEARCHIVE_EXTENSION] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    if (!filePath) return null;
    return openArchiveIntoTab(filePath);
  });

  handle(Channels.siteArchiveOpenPath, async (args) => openArchiveIntoTab(args.archivePath));

  handle(Channels.siteArchiveRevealInFolder, (args) => {
    if (existsSync(args.archivePath)) shell.showItemInFolder(args.archivePath);
    return { revealed: existsSync(args.archivePath) };
  });

  /**
   * "Open Live Version" from inside an archive. This is the one path that
   * deliberately leaves offline mode, so it always confirms first and only
   * ever opens http(s) in a normal browsing tab -- never through the OS
   * shell, and never for any other scheme.
   */
  handle(Channels.siteArchiveOpenLive, async (args) => {
    if (!/^https?:/i.test(args.url)) return { opened: false, reason: 'not-http' };
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Open Live Page', 'Stay Offline'],
      defaultId: 1,
      cancelId: 1,
      title: 'Leave the offline archive?',
      message: 'Open the live version of this page?',
      detail: `${args.url}\n\nThis uses your internet connection and leaves the offline archive.`,
    });
    if (response !== 0) return { opened: false, reason: 'declined' };
    const tabId = tabManager.createTab(args.url, false);
    tabManager.activateTab(tabId);
    return { opened: true, tabId };
  });

  /**
   * Links inside an archive that use mailto:, tel:, a custom protocol, or
   * point at an executable are never followed silently -- they come here
   * for an explicit confirmation, and executables are refused outright.
   */
  handle(Channels.siteArchiveConfirmExternal, async (args) => {
    if (isExecutableUrl(args.url)) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['OK'],
        title: 'Link blocked',
        message: 'This link points to an executable file.',
        detail: `Archive Browser will not open executables from archived pages.\n\n${args.url}`,
      });
      return { opened: false, reason: 'executable-blocked' };
    }

    const isHttp = /^https?:/i.test(args.url);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Open external link?',
      message: isHttp ? 'Open this link in a new tab?' : 'Open this link with an external application?',
      detail: `${args.url}\n\nThis link leaves the offline archive.`,
    });
    if (response !== 0) return { opened: false, reason: 'declined' };

    if (isHttp) {
      const tabId = tabManager.createTab(args.url, false);
      tabManager.activateTab(tabId);
      return { opened: true, tabId };
    }
    // Non-http schemes go to the OS handler only after this confirmation,
    // and only for schemes validated as safe (mailto:, tel:).
    if (/^(mailto|tel):/i.test(args.url)) {
      void shell.openExternal(args.url);
      return { opened: true };
    }
    return { opened: false, reason: 'unsupported-scheme' };
  });

  async function openArchiveIntoTab(archivePath: string): Promise<OpenedSiteArchive> {
    try {
      const archive = await openSiteArchive(archivePath);
      registerOpenedArchive(archive);
      const entryPageId = archive.entryPageId;
      if (!entryPageId) {
        archive.close();
        throw new SiteArchiveError('Archive contains no pages', 'empty-archive');
      }

      const sess = getSiteArchiveSession();
      const tabId = tabManager.openSiteArchiveTab(archive.manifest.archiveId, entryPageId, sess, {
        siteTitle: archive.manifest.siteTitle,
        archivePath,
      });
      tabManager.activateTab(tabId);

      return {
        archiveId: archive.manifest.archiveId,
        archivePath,
        siteTitle: archive.manifest.siteTitle,
        startUrl: archive.manifest.startUrl,
        capturedAt: archive.manifest.capturedAt,
        pageCount: archive.manifest.pages.length,
        assetCount: archive.manifest.assets.length,
        entryPageId,
        formatVersion: archive.manifest.formatVersion,
        appVersion: archive.manifest.appVersion,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof SiteArchiveError ? err.code : 'open-failed';
      logger.error('sitearchive.open_failed', { code, error: message });
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        buttons: ['OK'],
        title: 'Could not open archive',
        message: 'This website archive could not be opened.',
        detail: `${message}\n\n(${path.basename(archivePath)})`,
      });
      throw err;
    }
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120) || 'archive';
}
