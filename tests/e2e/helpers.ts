import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { startFixtureServer } from '../../fixtures/server';
import type { ArchiveRecord, LibraryResultItem, TabState, AppSettings } from '../../src/shared/types';

const ROOT = path.join(__dirname, '..', '..');

export interface AppHandle {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  close: () => Promise<void>;
}

/**
 * Types a URL into the trusted address bar and submits it.
 *
 * Guards against a real race. The address bar's displayed value is synced
 * from the active tab's live URL whenever the input isn't focused
 * ([Toolbar.tsx](../../src/renderer/components/Toolbar.tsx)), and React
 * commits the focus flag that suppresses that sync asynchronously. So a
 * `fill()` can be immediately readable as correct and then be overwritten
 * a moment later, when an in-flight tab-state update lands while the
 * component still believes the input is unfocused.
 *
 * The check therefore has to be "correct, and *still* correct a moment
 * later", and it has to sit inside the retry loop: an earlier version
 * broke out of the loop as soon as the value looked right and only then
 * asserted, so a clobber arriving after the break had nothing left to
 * re-fill the field and the assertion just polled the wrong value until
 * it timed out.
 */
export async function navigateViaAddressBar(handle: AppHandle, url: string): Promise<void> {
  const input = handle.window.locator('.address-bar-input');
  await expect(input).toBeEnabled();

  // Don't start typing into a field that is still being rewritten by a
  // navigation that hasn't settled yet.
  await waitForStableValue(handle, input);

  let lastSeen = await input.inputValue();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await input.click();
    await input.fill(url);

    await handle.window.waitForTimeout(100);
    lastSeen = await input.inputValue();
    if (lastSeen === url) {
      await input.press('Enter');
      return;
    }
  }

  throw new Error(
    `Address bar kept reverting while typing ${url}: last held ${JSON.stringify(lastSeen)} after 8 attempts`,
  );
}

/** Wait until the address bar stops changing on its own. */
async function waitForStableValue(
  handle: AppHandle,
  input: ReturnType<Page['locator']>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = await input.inputValue();
  while (Date.now() < deadline) {
    await handle.window.waitForTimeout(100);
    const current = await input.inputValue();
    if (current === previous) return;
    previous = current;
  }
}

/**
 * Launches the real, built app (dist/main/index.js) with an isolated
 * --user-data-dir per test so tests never touch (or depend on) real user
 * data, and with ARCHIVE_BROWSER_E2E=1 so the main process exposes
 * testHooks.ts's global for inspecting tab/capture/settings state.
 *
 * Playwright's Electron support enumerates every page-type CDP target in
 * the process -- that includes each tab's WebContentsView, not just the
 * trusted BrowserWindow -- so `app.firstWindow()` is not reliable here; it
 * can just as easily resolve to the initial about:blank browsing tab as to
 * the actual chrome window. findTrustedWindow() below waits for and
 * returns specifically the window serving dist/renderer/index.html (or the
 * Vite dev server in `npm run dev`). Tab content itself still has no
 * stable way for a test to identify or drive it directly (no fixed
 * URL/title to filter on, no preload), which is why testHooks.ts and
 * executeJavaScriptInTabForTesting() remain how tests inspect/drive tabs.
 */
export async function launchApp(): Promise<AppHandle> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-browser-e2e-'));
  return launchAppWithUserDataDir(userDataDir, true);
}

/** Like launchApp(), but reuses a specific --user-data-dir (e.g. to test restart recovery). */
export async function launchAppWithUserDataDir(userDataDir: string, cleanupOnClose: boolean): Promise<AppHandle> {
  const app = await electron.launch({
    args: [path.join(ROOT, 'dist/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ARCHIVE_BROWSER_E2E: '1', ARCHIVE_BROWSER_VITE_URL: '' },
  });
  if (process.env.DEBUG_E2E) {
    app.process().stdout?.on('data', (d) => console.log('[main stdout]', d.toString()));
    app.process().stderr?.on('data', (d) => console.log('[main stderr]', d.toString()));
    app.process().on('exit', (code, signal) => console.log('[e2e] process exit', code, signal));
    app.process().on('error', (err) => console.log('[e2e] process error', err));
    app.on('window', (w) => console.log('[e2e] new window target:', w.url()));
    app.on('close', () => console.log('[e2e] app close event'));
  }
  const window = await findTrustedWindow(app);
  await window.waitForLoadState('domcontentloaded');
  return {
    app,
    window,
    userDataDir,
    close: async () => {
      await app.close().catch(() => {});
      if (cleanupOnClose) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function findTrustedWindow(app: ElectronApplication): Promise<Page> {
  const isTrusted = (w: Page) => {
    const url = w.url();
    return url.includes('renderer/index.html') || url.includes('localhost:5173');
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    const match = app.windows().find(isTrusted);
    if (match) return match;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the trusted chrome window to appear');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function withFixtureServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { server, url } = await startFixtureServer();
  try {
    return await fn(url);
  } finally {
    server.close();
  }
}

// NOTE: ElectronApplication.evaluate(pageFunction, arg) invokes
// pageFunction(electronModule, arg) inside the main process -- the first
// parameter is always the `electron` API namespace, never our arg. Every
// callback below takes that as an (unused) first parameter, e.g.
// `({}, arg) => ...`, so the second parameter is actually our payload.
export function testHooks(app: ElectronApplication) {
  return {
    listTabs: (): Promise<TabState[]> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.tabManager.list()),
    queryArchives: (query: Record<string, unknown> = {}): Promise<{ items: LibraryResultItem[]; total: number }> =>
      app.evaluate(
        ({}, q) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.archiveRepo.query(q),
        query,
      ),
    getSettings: (): Promise<AppSettings> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.settings.get()),
    updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      app.evaluate(
        ({}, p) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.settings.update(p),
        patch,
      ),
    archivesRoot: (): Promise<string> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.settings.get().archiveStorageDir),
    evalInActiveTab: async (script: string): Promise<unknown> => {
      const tabId = await app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.tabManager.getActiveTabId());
      return app.evaluate(
        ({}, args: { tabId: string; script: string }) =>
          (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.tabManager.executeJavaScriptInTabForTesting(
            args.tabId,
            args.script,
          ),
        { tabId, script },
      );
    },
    readArchiveText: (archiveId: string): Promise<string> =>
      app.evaluate(
        ({}, id: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.readArchiveText(id),
        archiveId,
      ),
    simulateCrashedCapture: (): Promise<string> =>
      app.evaluate(() => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.simulateCrashedCapture()),
    stagingDirExists: (archiveId: string): Promise<boolean> =>
      app.evaluate(
        ({}, id: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.stagingDirExists(id),
        archiveId,
      ),
    isInterruptedCaptureTracked: (archiveId: string): Promise<boolean> =>
      app.evaluate(
        ({}, id: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.isInterruptedCaptureTracked(id),
        archiveId,
      ),
    exportLibraryToPath: (destZipPath: string): Promise<{ archiveCount: number }> =>
      app.evaluate(
        ({}, p: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.exportLibraryToPath(p),
        destZipPath,
      ),
    importLibraryFromPath: (
      zipPath: string,
    ): Promise<{ importedCount: number; skippedCount: number; failedCount: number }> =>
      app.evaluate(
        ({}, p: string) => (globalThis as any).__ARCHIVE_BROWSER_TEST_HOOKS__.importLibraryFromPath(p),
        zipPath,
      ),
  };
}

export async function waitForArchiveCount(
  app: ElectronApplication,
  predicate: (items: ArchiveRecord[]) => boolean,
  timeoutMs = 15_000,
): Promise<ArchiveRecord[]> {
  const hooks = testHooks(app);
  const start = Date.now();
  for (;;) {
    const { items } = await hooks.queryArchives({ sort: 'newest', limit: 100, offset: 0 });
    if (predicate(items)) return items;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for archive predicate. Last items: ${JSON.stringify(items, null, 2)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Polls tabManager.list() until `predicate` matches. Tab creation
 * (e.g. Library's "Open offline") is an async IPC round-trip, so a fixed
 * `waitForTimeout` after clicking is inherently racy -- this waits for the
 * actual resulting state instead.
 */
export async function waitForTabs(
  app: ElectronApplication,
  predicate: (tabs: TabState[]) => boolean,
  timeoutMs = 10_000,
): Promise<TabState[]> {
  const hooks = testHooks(app);
  const start = Date.now();
  for (;;) {
    const tabs = await hooks.listTabs();
    if (predicate(tabs)) return tabs;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for tabs predicate. Last tabs: ${JSON.stringify(tabs, null, 2)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function randomId(): string {
  return crypto.randomUUID();
}
