import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, session, BrowserWindow } from 'electron';
import type { ArchiveRepo } from './db/archiveRepo';
import type { SettingsStore } from './settings/settingsStore';
import type { TabManager } from './browser/tabManager';
import type { CaptureManager } from './sitearchive/captureManager';
import type { CaptureProgress, CaptureResult, CaptureScope } from '../shared/sitearchiveTypes';
import { openSiteArchive } from './sitearchive/archiveReader';
import { registerOpenedArchive, getSiteArchiveSession } from './sitearchive/sitearchiveSession';
import { discardRecoveredCapture, finalizeRecoveredCapture, listRecoverableCaptures } from './sitearchive/archiveWriter';

/**
 * A narrow, explicit back door for end-to-end tests. Playwright's Electron
 * support can only attach to real BrowserWindows (our trusted chrome
 * window), not the WebContentsView instances tabs are made of, so tests
 * need *some* way to inspect capture/tab/settings state from the main
 * process. This is only ever populated when ARCHIVE_BROWSER_E2E=1 is set
 * in the environment (see package.json's test:e2e script and
 * playwright.config.ts) -- it does not exist in a normal run, and nothing
 * in the renderer or any webContents can reach it (it's not on
 * contextBridge or any IPC channel).
 *
 * Methods here (rather than raw `require()` calls inside a test's
 * `electronApplication.evaluate()` callback) are how tests touch the
 * filesystem from the main process: Playwright serializes evaluate()
 * callbacks and re-evaluates them in a restricted context with no
 * `require` in scope, so any Node API a test needs has to be wrapped in a
 * real method here, compiled normally, not stringified.
 */
export interface TestHooks {
  archiveRepo: ArchiveRepo;
  settings: SettingsStore;
  tabManager: TabManager;
  captureManager: CaptureManager;
  /** Drive a .sitearchive capture without going through the save dialog. */
  captureSiteToPath: (input: {
    tabId: string;
    scope: CaptureScope;
    outputPath: string;
  }) => Promise<{ jobId: string }>;
  /** Await the currently running capture, resolving null if it was cancelled. */
  awaitCapture: () => Promise<CaptureResult | null>;
  cancelCapture: () => boolean;
  pauseCapture: () => boolean;
  resumeCapture: () => boolean;
  lastCaptureProgress: () => CaptureProgress | null;
  openSiteArchivePath: (archivePath: string) => Promise<string>;
  readArchiveText: (archiveId: string) => Promise<string>;
  /** Simulates a process that died mid-capture: bookkeeping row + orphaned staging dir, no final archive. */
  simulateCrashedCapture: () => Promise<string>;
  stagingDirExists: (archiveId: string) => Promise<boolean>;
  isInterruptedCaptureTracked: (archiveId: string) => boolean;
  /** Interrupted .sitearchive captures whose staged work can still be salvaged. */
  listRecoverableCaptures: () => Promise<
    Array<{ stagingDir: string; archiveId: string; startUrl: string; outputPath: string; bytesOnDisk: number }>
  >;
  /** Write what an interrupted capture managed to capture, without crawling further. */
  finalizeRecoveredCapture: (
    stagingDir: string,
  ) => Promise<{ archivePath: string; pageCount: number; assetCount: number; fileSizeBytes: number } | null>;
  /** Continue an interrupted capture from its checkpoint. */
  resumeInterruptedCapture: (stagingDir: string) => Promise<{ jobId: string } | null>;
  /** Throw away an interrupted capture and everything it staged. */
  discardRecoveredCapture: (stagingDir: string) => Promise<boolean>;
}

declare global {
  // eslint-disable-next-line no-var
  var __ARCHIVE_BROWSER_TEST_HOOKS__: TestHooks | undefined;
}

export function installTestHooks(
  hooks: Pick<TestHooks, 'archiveRepo' | 'settings' | 'tabManager' | 'captureManager'>,
): void {
  if (process.env.ARCHIVE_BROWSER_E2E !== '1') return;

  // Capture state the e2e tests observe, kept here rather than reaching
  // into CaptureManager's internals from a test.
  let capturePromise: Promise<CaptureResult | null> | null = null;
  let activeJobId: string | null = null;
  let lastProgress: CaptureProgress | null = null;
  hooks.captureManager.onProgress((p) => {
    lastProgress = p;
  });

  globalThis.__ARCHIVE_BROWSER_TEST_HOOKS__ = {
    ...hooks,
    captureSiteToPath: async ({ tabId, scope, outputPath }) => {
      const tab = hooks.tabManager.getTabInfo(tabId);
      if (!tab) throw new Error('Tab not found');
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No window');
      const { jobId, promise } = await hooks.captureManager.start({
        window: win,
        session: session.fromPartition('persist:browsing'),
        startUrl: tab.url,
        scope,
        outputPath,
      });
      activeJobId = jobId;
      capturePromise = promise.catch(() => null);
      return { jobId };
    },
    awaitCapture: async () => (capturePromise ? capturePromise : null),
    cancelCapture: () => (activeJobId ? hooks.captureManager.cancel(activeJobId) : false),
    pauseCapture: () => (activeJobId ? hooks.captureManager.pause(activeJobId) : false),
    resumeCapture: () => (activeJobId ? hooks.captureManager.resume(activeJobId) : false),
    lastCaptureProgress: () => lastProgress,
    openSiteArchivePath: async (archivePath: string) => {
      const archive = await openSiteArchive(archivePath);
      registerOpenedArchive(archive);
      const entryPageId = archive.entryPageId;
      if (!entryPageId) throw new Error('Archive has no pages');
      const tabId = hooks.tabManager.openSiteArchiveTab(
        archive.manifest.archiveId,
        entryPageId,
        getSiteArchiveSession(),
        { siteTitle: archive.manifest.siteTitle, archivePath },
      );
      hooks.tabManager.activateTab(tabId);
      return tabId;
    },
    readArchiveText: async (archiveId: string) => {
      const root = hooks.settings.get().archiveStorageDir;
      try {
        return await fs.readFile(path.join(root, archiveId, 'text.txt'), 'utf8');
      } catch {
        return '';
      }
    },
    simulateCrashedCapture: async () => {
      const id = crypto.randomUUID();
      hooks.archiveRepo.markCaptureStarted(id);
      const root = hooks.settings.get().archiveStorageDir;
      const stagingDir = path.join(root, `.tmp-${id}`);
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'page.mhtml'), 'partial content');
      return id;
    },
    stagingDirExists: async (archiveId: string) => {
      const root = hooks.settings.get().archiveStorageDir;
      try {
        await fs.stat(path.join(root, `.tmp-${archiveId}`));
        return true;
      } catch {
        return false;
      }
    },
    isInterruptedCaptureTracked: (archiveId: string) => hooks.archiveRepo.listInterruptedCaptureIds().includes(archiveId),
    listRecoverableCaptures: async () => {
      const found = await listRecoverableCaptures(app.getPath('temp'));
      return found.map((r) => ({
        stagingDir: r.stagingDir,
        archiveId: r.meta.archiveId,
        startUrl: r.meta.startUrl,
        outputPath: r.meta.outputPath,
        bytesOnDisk: r.bytesOnDisk,
      }));
    },
    finalizeRecoveredCapture: async (stagingDir: string) =>
      finalizeRecoveredCapture(stagingDir, app.getVersion()),
    discardRecoveredCapture: (stagingDir: string) => discardRecoveredCapture(stagingDir),
    resumeInterruptedCapture: async (stagingDir: string) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No window');
      const started = await hooks.captureManager.resumeInterrupted({
        window: win,
        session: session.fromPartition('persist:browsing'),
        stagingDir,
      });
      if (!started) return null;
      activeJobId = started.jobId;
      capturePromise = started.promise.catch(() => null);
      return { jobId: started.jobId };
    },
  };
}
