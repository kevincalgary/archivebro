import type { ElectronApplication } from '@playwright/test';
import { startSiteFixtureServer } from '../../fixtures/siteServer';
import type { CaptureProgress, CaptureResult, CaptureScope } from '../../src/shared/sitearchiveTypes';
import { DEFAULT_CAPTURE_SCOPE, DEFAULT_SITE_SCOPE, DEFAULT_FORUM_THREAD_SCOPE, DEFAULT_FORUM_SECTION_SCOPE, DEFAULT_FORUM_WHOLE_SCOPE } from '../../src/shared/sitearchiveTypes';
import { testHooks } from './helpers';

export interface SiteFixture {
  url: string;
  close: () => void;
  getRequestLog: () => Array<{ method: string; url: string }>;
  /** A genuinely externally-hosted image, served from a second real origin -- see startExternalImageServer in siteServer.js. */
  externalImageUrl: string;
}

export async function withSiteFixture<T>(fn: (fixture: SiteFixture) => Promise<T>): Promise<T> {
  const { server, url, externalImageUrl, getRequestLog } = await startSiteFixtureServer();
  const fixture: SiteFixture = { url, close: () => server.close(), getRequestLog, externalImageUrl };
  try {
    return await fn(fixture);
  } finally {
    server.close();
  }
}

/**
 * Dismiss the capture progress/completion dialog if it is showing.
 *
 * The dialog deliberately stays up after a capture finishes so the user
 * can read the summary and choose Open Archive / Reveal / Close -- but its
 * overlay covers the toolbar, so tests that go on to click toolbar buttons
 * must close it first, exactly as a user would.
 */
export async function dismissCaptureDialog(handle: { window: import('@playwright/test').Page }): Promise<void> {
  const page = handle.window;
  const overlay = page.locator('.capture-progress-dialog');
  if ((await overlay.count()) === 0) return;

  // The dialog re-renders on every progress event, so a locator resolved
  // for a normal click can be detached by React before the click lands
  // (Playwright then reports the overlay as intercepting). Dispatching the
  // click through the DOM sidesteps that race; this helper only exists to
  // get the overlay out of the way, and the dialog's own button behaviour
  // is covered by the dedicated UI test in sitearchive-ui.spec.ts.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.capture-progress-dialog button')];
      const close = buttons.find((b) => b.textContent?.trim() === 'Close') as HTMLButtonElement | undefined;
      if (close) {
        close.click();
        return true;
      }
      return false;
    });
    if (clicked && (await overlay.count()) === 0) return;
    await page.waitForTimeout(200);
    if ((await overlay.count()) === 0) return;
  }

  throw new Error('Capture dialog did not close');
}

export function currentPageScope(overrides: Partial<CaptureScope> = {}): CaptureScope {
  return { ...DEFAULT_CAPTURE_SCOPE, ...overrides };
}

export function siteScope(overrides: Partial<CaptureScope> = {}): CaptureScope {
  return { ...DEFAULT_SITE_SCOPE, crawlDelayMs: 0, ...overrides };
}

export function forumThreadScope(overrides: Partial<CaptureScope> = {}): CaptureScope {
  return { ...DEFAULT_FORUM_THREAD_SCOPE, crawlDelayMs: 0, ...overrides };
}

export function forumSectionScope(overrides: Partial<CaptureScope> = {}): CaptureScope {
  return { ...DEFAULT_FORUM_SECTION_SCOPE, crawlDelayMs: 0, ...overrides };
}

export function forumWholeScope(overrides: Partial<CaptureScope> = {}): CaptureScope {
  return { ...DEFAULT_FORUM_WHOLE_SCOPE, crawlDelayMs: 0, ...overrides };
}

/** Extra sitearchive-specific hooks layered on the shared testHooks(). */
export function siteHooks(app: ElectronApplication) {
  const base = testHooks(app);
  return {
    ...base,
    captureSiteToPath: (tabId: string, scope: CaptureScope, outputPath: string): Promise<{ jobId: string }> =>
      app.evaluate(
        ({}, args: { tabId: string; scope: CaptureScope; outputPath: string }) =>
          (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.captureSiteToPath(args),
        { tabId, scope, outputPath },
      ),
    awaitCapture: (): Promise<CaptureResult | null> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.awaitCapture()),
    retryFailedPages: (archivePath: string): Promise<{ jobId: string }> =>
      app.evaluate(
        ({}, p: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.retryFailedPages(p),
        archivePath,
      ),
    cancelCapture: (): Promise<boolean> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.cancelCapture()),
    pauseCapture: (): Promise<boolean> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.pauseCapture()),
    resumeCapture: (): Promise<boolean> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.resumeCapture()),
    lastCaptureProgress: (): Promise<CaptureProgress | null> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.lastCaptureProgress()),
    /**
     * The native tab view's bounds. Width/height of 0 means the page is not
     * covering the window, so an HTML dialog is genuinely visible on screen
     * -- something DOM-level visibility checks cannot tell you.
     */
    contentBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.tabManager.getContentBounds()),
    openSiteArchivePath: (archivePath: string): Promise<string> =>
      app.evaluate(
        ({}, p: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.openSiteArchivePath(p),
        archivePath,
      ),
    listRecoverableCaptures: (): Promise<
      Array<{ stagingDir: string; archiveId: string; startUrl: string; outputPath: string; bytesOnDisk: number }>
    > => app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.listRecoverableCaptures()),
    finalizeRecoveredCapture: (
      stagingDir: string,
    ): Promise<{ archivePath: string; pageCount: number; assetCount: number; fileSizeBytes: number } | null> =>
      app.evaluate(
        ({}, d: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.finalizeRecoveredCapture(d),
        stagingDir,
      ),
    discardRecoveredCapture: (stagingDir: string): Promise<boolean> =>
      app.evaluate(
        ({}, d: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.discardRecoveredCapture(d),
        stagingDir,
      ),
    resumeInterruptedCapture: (stagingDir: string): Promise<{ jobId: string } | null> =>
      app.evaluate(
        ({}, d: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.resumeInterruptedCapture(d),
        stagingDir,
      ),
  };
}
