import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { WebContents } from 'electron';
import { net } from 'electron';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { SettingsStore } from '../settings/settingsStore';
import { archiveFilePaths } from '../util/paths';
import { atomicWriteFile, withStagedArchiveDir } from '../util/atomicWrite';
import { logger, redactUrl } from '../util/logger';
import { canonicalizeUrl, extractDomain } from '../browser/urlUtils';
import { captureFullPageScreenshot } from './screenshotCapture';
import { extractVisibleText } from './textExtraction';
import { hasSufficientDiskSpace } from './diskSpace';
import { sha256Hex } from '../util/hash';
import type { CaptureStatus, CaptureWarning } from '../../shared/types';
import { APP_VERSION, SCHEMA_VERSION } from '../appMeta';

export interface PendingNavigation {
  tabId: string;
  originalUrl: string;
  referrerUrl: string | null;
  visitedAt: string;
  isPrivate: boolean;
  isArchivingPaused: boolean;
}

export type CaptureStatusListener = (tabId: string, status: CaptureStatus, archiveId?: string) => void;

interface TabTimerState {
  timer: ReturnType<typeof setTimeout> | null;
  pending: PendingNavigation | null;
  lastCanonicalUrl: string | null;
  lastTitle: string | null;
  inFlight: boolean;
}

export class CaptureService {
  private tabStates = new Map<string, TabTimerState>();
  private listeners: CaptureStatusListener[] = [];

  constructor(
    private repo: ArchiveRepo,
    private settings: SettingsStore,
  ) {}

  onCaptureStatus(listener: CaptureStatusListener): void {
    this.listeners.push(listener);
  }

  private emit(tabId: string, status: CaptureStatus, archiveId?: string): void {
    for (const l of this.listeners) l(tabId, status, archiveId);
  }

  private stateFor(tabId: string): TabTimerState {
    let s = this.tabStates.get(tabId);
    if (!s) {
      s = { timer: null, pending: null, lastCanonicalUrl: null, lastTitle: null, inFlight: false };
      this.tabStates.set(tabId, s);
    }
    return s;
  }

  disposeTab(tabId: string): void {
    const s = this.tabStates.get(tabId);
    if (s?.timer) clearTimeout(s.timer);
    this.tabStates.delete(tabId);
  }

  /** Called on `did-navigate` (a real top-level, non-iframe navigation). */
  notifyTopLevelNavigation(webContents: WebContents, nav: PendingNavigation): void {
    const state = this.stateFor(nav.tabId);
    if (state.timer) clearTimeout(state.timer);
    state.pending = nav;
    this.scheduleCapture(webContents, nav.tabId);
  }

  /**
   * Called on `did-navigate-in-page` (SPA route change / hash change).
   * Filters out changes that aren't a meaningful page transition and
   * debounces bursts of history.pushState calls that some frameworks fire
   * in quick succession during a single logical navigation.
   */
  notifyInPageNavigation(webContents: WebContents, tabId: string, newUrl: string, referrerUrl: string | null, isPrivate: boolean, isArchivingPaused: boolean): void {
    const state = this.stateFor(tabId);
    const newCanonical = canonicalizeUrl(newUrl);

    if (state.lastCanonicalUrl && newCanonical === state.lastCanonicalUrl) {
      // Hash-only change against a URL we've already captured/queued for
      // this pathname+search -- not a meaningful transition.
      return;
    }

    if (state.timer) clearTimeout(state.timer);
    state.pending = {
      tabId,
      originalUrl: newUrl,
      referrerUrl,
      visitedAt: new Date().toISOString(),
      isPrivate,
      isArchivingPaused,
    };
    this.scheduleCapture(webContents, tabId);
  }

  private scheduleCapture(webContents: WebContents, tabId: string): void {
    const state = this.stateFor(tabId);
    const delay = this.settings.get().captureDelayMs;
    this.emit(tabId, 'pending');
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runCapture(webContents, tabId);
    }, delay);
  }

  private async runCapture(webContents: WebContents, tabId: string): Promise<void> {
    const state = this.stateFor(tabId);
    const nav = state.pending;
    state.pending = null;
    if (!nav || webContents.isDestroyed() || state.inFlight) return;

    state.inFlight = true;
    try {
      await this.capture(webContents, nav);
    } finally {
      state.inFlight = false;
    }
  }

  private async capture(webContents: WebContents, nav: PendingNavigation): Promise<void> {
    const finalUrl = webContents.getURL();
    const domain = extractDomain(finalUrl);
    const canonicalUrl = canonicalizeUrl(finalUrl);
    const settings = this.settings.get();

    if (nav.isPrivate) {
      this.emit(nav.tabId, 'skipped-private');
      return;
    }
    if (!/^https?:$/i.test(safeProtocol(finalUrl))) {
      this.emit(nav.tabId, 'skipped-non-http');
      return;
    }
    if (nav.isArchivingPaused) {
      this.emit(nav.tabId, 'skipped-excluded'); // reuse status; UI shows "paused" via tab state separately
      return;
    }
    if (!settings.autoCaptureEnabled) {
      this.emit(nav.tabId, 'skipped-excluded'); // reuse status, same as the per-tab pause above
      return;
    }
    if (this.settings.isDomainExcluded(domain)) {
      this.emit(nav.tabId, 'skipped-excluded');
      return;
    }

    this.stateFor(nav.tabId).lastCanonicalUrl = canonicalUrl;

    const archiveId = crypto.randomUUID();
    const archivesRoot = settings.archiveStorageDir;
    const paths = archiveFilePaths(archivesRoot, archiveId);
    const warnings: CaptureWarning[] = [];

    this.emit(nav.tabId, 'capturing');
    this.repo.markCaptureStarted(archiveId);

    if (!(await hasSufficientDiskSpace(archivesRoot))) {
      warnings.push({ code: 'insufficient-disk-space', message: 'Not enough free disk space to capture this page.' });
      this.repo.insert({
        id: archiveId,
        canonicalUrl,
        originalUrl: nav.originalUrl,
        finalUrl,
        title: safeTitle(webContents),
        domain,
        faviconPath: null,
        referrerUrl: nav.referrerUrl,
        capturedAt: new Date().toISOString(),
        visitedAt: nav.visitedAt,
        status: 'failed',
        warnings,
        sizeBytes: 0,
        appVersion: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        hasMhtml: false,
        hasScreenshot: false,
        hasText: false,
        mhtmlSha256: null,
        screenshotSha256: null,
        textSha256: null,
      });
      this.repo.markCaptureFinished(archiveId);
      this.emit(nav.tabId, 'failed', archiveId);
      logger.error('capture.disk_space', { archiveId, domain });
      return;
    }

    let hasMhtml = false;
    let hasScreenshot = false;
    let hasText = false;
    let mhtmlSha256: string | null = null;
    let screenshotSha256: string | null = null;
    let textSha256: string | null = null;
    let extractedText = '';
    let faviconPath: string | null = null;
    const title = safeTitle(webContents);

    try {
      await withStagedArchiveDir(archivesRoot, archiveId, paths.dir, async (stagingDir) => {
        const staged = archiveFilePaths(archivesRoot, archiveId);
        const stagedMhtml = staged.mhtml.replace(paths.dir, stagingDir);
        const stagedScreenshot = staged.screenshot.replace(paths.dir, stagingDir);
        const stagedText = staged.text.replace(paths.dir, stagingDir);
        const stagedMeta = staged.metadata.replace(paths.dir, stagingDir);
        const stagedFavicon = staged.favicon.replace(paths.dir, stagingDir);

        if (webContents.isDestroyed()) throw new Error('webContents destroyed before capture');

        try {
          await webContents.savePage(stagedMhtml, 'MHTML');
          hasMhtml = true;
          // savePage() writes directly to disk rather than returning bytes,
          // so the hash is computed by reading the file straight back --
          // this is the one avenue that ensures we hash exactly what
          // landed on disk, not what we intended to write.
          mhtmlSha256 = sha256Hex(await fs.readFile(stagedMhtml));
        } catch (err) {
          warnings.push({ code: 'mhtml-failed', message: describeError(err) });
          logger.warn('capture.mhtml_failed', { archiveId, domain, error: describeError(err) });
        }

        try {
          const shot = await captureFullPageScreenshot(webContents, settings.screenshotQuality);
          await atomicWriteFile(stagedScreenshot, shot.png);
          hasScreenshot = true;
          screenshotSha256 = sha256Hex(shot.png);
          if (shot.kind === 'viewport') {
            // The archive still gets a screenshot, but not the full-page
            // one it is supposed to hold. Say so instead of reporting a
            // clean success.
            warnings.push({
              code: 'screenshot-viewport-only',
              message: `Full-page screenshot failed; saved a viewport-sized screenshot instead (${shot.reason ?? 'unknown reason'})`,
            });
            logger.warn('capture.screenshot_viewport_only', { archiveId, domain, error: shot.reason });
          }
        } catch (err) {
          warnings.push({ code: 'screenshot-failed', message: describeError(err) });
          logger.warn('capture.screenshot_failed', { archiveId, domain, error: describeError(err) });
        }

        try {
          extractedText = await extractVisibleText(webContents);
          await atomicWriteFile(stagedText, extractedText);
          hasText = true;
          textSha256 = sha256Hex(extractedText);
        } catch (err) {
          warnings.push({ code: 'text-extraction-failed', message: describeError(err) });
          logger.warn('capture.text_failed', { archiveId, domain, error: describeError(err) });
        }

        try {
          const faviconUrl = await tryGetFaviconUrl(webContents);
          if (faviconUrl) {
            const buf = await downloadFavicon(faviconUrl);
            if (buf) {
              await atomicWriteFile(stagedFavicon, buf);
              faviconPath = paths.favicon;
            }
          }
        } catch {
          // favicon is best-effort; absence is not a warning-worthy failure
        }

        if (!hasMhtml && !hasScreenshot && !hasText) {
          throw new Error('All capture steps failed');
        }

        const record = {
          id: archiveId,
          canonicalUrl,
          originalUrl: nav.originalUrl,
          finalUrl,
          title,
          domain,
          faviconPath,
          referrerUrl: nav.referrerUrl,
          capturedAt: new Date().toISOString(),
          visitedAt: nav.visitedAt,
        };
        await atomicWriteFile(
          stagedMeta,
          JSON.stringify(
            { ...record, warnings, hasMhtml, hasScreenshot, hasText, mhtmlSha256, screenshotSha256, textSha256 },
            null,
            2,
          ),
        );
        this.stateFor(nav.tabId).lastTitle = title;
      });

      const sizeBytes = await directorySize(paths.dir);
      this.repo.insert({
        id: archiveId,
        canonicalUrl,
        originalUrl: nav.originalUrl,
        finalUrl,
        title,
        domain,
        faviconPath,
        referrerUrl: nav.referrerUrl,
        capturedAt: new Date().toISOString(),
        visitedAt: nav.visitedAt,
        status: 'success',
        warnings,
        sizeBytes,
        appVersion: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        hasMhtml,
        hasScreenshot,
        hasText,
        mhtmlSha256,
        screenshotSha256,
        textSha256,
      });
      if (extractedText) this.repo.updateExtractedText(archiveId, extractedText);
      this.repo.markCaptureFinished(archiveId);
      this.emit(nav.tabId, 'success', archiveId);
      logger.info('capture.success', { archiveId, domain: redactUrl(finalUrl), hasMhtml, hasScreenshot, hasText, warningCount: warnings.length });
    } catch (err) {
      warnings.push({ code: 'capture-failed', message: describeError(err) });
      this.repo.insert({
        id: archiveId,
        canonicalUrl,
        originalUrl: nav.originalUrl,
        finalUrl,
        title: safeTitle(webContents),
        domain,
        faviconPath: null,
        referrerUrl: nav.referrerUrl,
        capturedAt: new Date().toISOString(),
        visitedAt: nav.visitedAt,
        status: 'failed',
        warnings,
        sizeBytes: 0,
        appVersion: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        hasMhtml: false,
        hasScreenshot: false,
        hasText: false,
        mhtmlSha256: null,
        screenshotSha256: null,
        textSha256: null,
      });
      this.repo.markCaptureFinished(archiveId);
      this.emit(nav.tabId, 'failed', archiveId);
      logger.error('capture.failed', { archiveId, domain, error: describeError(err) });
    }
  }
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function safeTitle(webContents: WebContents): string {
  try {
    return webContents.isDestroyed() ? '' : webContents.getTitle();
  } catch {
    return '';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tryGetFaviconUrl(webContents: WebContents): Promise<string | null> {
  if (webContents.isDestroyed()) return null;
  try {
    const result = await webContents.executeJavaScript(
      `(function(){ var l = document.querySelector('link[rel~="icon"]'); return l ? l.href : (location.origin + '/favicon.ico'); })()`,
      true,
    );
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

async function downloadFavicon(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      const chunks: Buffer[] = [];
      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          resolve(null);
          return;
        }
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
        response.on('error', () => resolve(null));
      });
      request.on('error', () => resolve(null));
      request.end();
    } catch {
      resolve(null);
    }
  });
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) total += await directorySize(full);
      else total += (await fs.stat(full)).size;
    }
  } catch {
    // dir may not exist if everything failed
  }
  return total;
}
