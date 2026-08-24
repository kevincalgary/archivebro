import crypto from 'node:crypto';
import { BrowserWindow, WebContentsView, session, shell, dialog, type Rectangle } from 'electron';
import type { TabState, CaptureStatus } from '../../shared/types';
import type { SettingsStore } from '../settings/settingsStore';
import type { CaptureService } from '../capture/captureService';
import { installPermissionHandlers } from '../security/permissions';
import { isSafeRemoteUrl, isSafeExternalUrl, resolveAddressBarInput } from './urlUtils';
import { logger, redactUrl } from '../util/logger';
import { ARCHIVE_SITE_SCHEME } from '../sitearchive/constants';

interface Tab {
  id: string;
  view: WebContentsView;
  isPrivate: boolean;
  isArchivingPaused: boolean;
  previousUrl: string | null;
  lastCaptureStatus: CaptureStatus | null;
  favicon: string | null;
  kind: 'live' | 'offline' | 'sitearchive';
  offlineArchiveId: string | null;
  /** Set only for 'sitearchive' tabs: the .sitearchive file on disk. */
  siteArchivePath?: string;
  siteArchiveTitle?: string;
  /**
   * The URL that kicked off the navigation currently in flight -- set
   * before loadURL() for address-bar/programmatic navigations, and on
   * 'will-navigate' for link clicks / page-initiated navigations.
   * Deliberately NOT updated on 'will-redirect', so it still reflects the
   * pre-redirect URL by the time 'did-navigate' fires with the final one.
   */
  pendingOriginalUrl: string | null;
}

export type TabStateListener = (state: TabState) => void;
export type TabClosedListener = (tabId: string) => void;

const configuredSessions = new Set<string>();

export class TabManager {
  private tabs = new Map<string, Tab>();
  private activeTabId: string | null = null;
  private contentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private stateListeners: TabStateListener[] = [];
  private closedListeners: TabClosedListener[] = [];
  private activatedListeners: Array<(tabId: string) => void> = [];
  private openLiveListeners: Array<(url: string) => void> = [];
  private externalLinkListeners: Array<(url: string) => void> = [];

  constructor(
    private mainWindow: BrowserWindow,
    private settings: SettingsStore,
    private captureService: CaptureService,
  ) {
    this.captureService.onCaptureStatus((tabId, status) => {
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      tab.lastCaptureStatus = status;
      this.emitState(tab);
    });
  }

  onTabState(listener: TabStateListener): void {
    this.stateListeners.push(listener);
  }

  onTabClosed(listener: TabClosedListener): void {
    this.closedListeners.push(listener);
  }

  list(): TabState[] {
    return [...this.tabs.values()].map((t) => this.toTabState(t));
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /**
   * Bounds currently assigned to the active tab's native view. A zero-size
   * rect means the web page is not covering the window, which is what lets
   * HTML dialogs actually be seen. Exposed so tests can assert real
   * occlusion rather than DOM-only visibility.
   */
  getContentBounds(): Rectangle {
    return this.contentBounds;
  }

  /** Current URL/title for a tab, used by the sitearchive capture flow. */
  getTabInfo(tabId: string): { url: string; title: string } | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    return { url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() };
  }

  /**
   * Open a tab viewing a portable .sitearchive.
   *
   * Unlike the single-page offline viewer, archived sites need their own
   * scripts to run (many pages only render via JS), so JavaScript stays
   * enabled here. That is safe because the session this runs on blocks
   * every network request that isn't archive-site:// -- an archived script
   * has nowhere to send anything and nothing to fetch. Node integration
   * stays off, context isolation and sandboxing stay on, and no preload
   * is attached, so archived content still has no path to Electron, Node,
   * the filesystem, or IPC.
   */
  openSiteArchiveTab(
    archiveId: string,
    entryPageId: string,
    archiveSession: Electron.Session,
    meta: { siteTitle: string; archivePath: string },
  ): string {
    const view = new WebContentsView({
      webPreferences: {
        session: archiveSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: true,
        images: true,
      },
    });

    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      view,
      isPrivate: false,
      isArchivingPaused: true,
      previousUrl: null,
      lastCaptureStatus: null,
      favicon: null,
      kind: 'sitearchive',
      offlineArchiveId: archiveId,
      pendingOriginalUrl: null,
      siteArchivePath: meta.archivePath,
      siteArchiveTitle: meta.siteTitle,
    };
    this.tabs.set(id, tab);

    const wc = view.webContents;
    wc.on('did-start-loading', () => this.emitState(tab));
    wc.on('did-stop-loading', () => this.emitState(tab));
    wc.on('did-navigate', () => this.emitState(tab));
    wc.on('did-navigate-in-page', () => this.emitState(tab));
    wc.on('page-title-updated', (event, title) => {
      // The "not captured" page signals an Open Live Version request by
      // setting its own title, since archived content has no IPC access.
      const prefix = 'ARCHIVE_OPEN_LIVE:';
      if (title.startsWith(prefix)) {
        event.preventDefault?.();
        const url = title.slice(prefix.length);
        for (const l of this.openLiveListeners) l(url);
        return;
      }
      this.emitState(tab);
    });

    // Archived pages may only navigate within their own archive.
    wc.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${ARCHIVE_SITE_SCHEME}://${archiveId}`)) {
        event.preventDefault();
        logger.warn('sitearchive_tab.navigation_blocked', {});
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      // Popups from archived content are never opened directly; they are
      // routed through the same external-link confirmation as normal links.
      for (const l of this.externalLinkListeners) l(url);
      return { action: 'deny' };
    });

    this.mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    void wc.loadURL(`${ARCHIVE_SITE_SCHEME}://${archiveId}/page/${entryPageId}`);

    this.emitState(tab);
    return id;
  }

  /** The archive a site-archive tab is viewing, or null for any other kind of tab. */
  getSiteArchiveIdForTab(tabId: string): string | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'sitearchive') return null;
    return tab.offlineArchiveId;
  }

  /**
   * Jump an already-open site-archive tab to a specific page, e.g. from a
   * search result. Refuses if the tab isn't actually a site-archive tab
   * for exactly this archive -- defense in depth against a renderer-
   * supplied pageId being pointed at the wrong tab, even though pageId
   * itself is just a UUID looked up server-side by whoever calls this.
   */
  navigateSiteArchiveTab(tabId: string, archiveId: string, pageId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'sitearchive' || tab.offlineArchiveId !== archiveId) return false;
    if (tab.view.webContents.isDestroyed()) return false;
    void tab.view.webContents.loadURL(`${ARCHIVE_SITE_SCHEME}://${archiveId}/page/${pageId}`);
    return true;
  }

  onSiteArchiveOpenLive(listener: (url: string) => void): void {
    this.openLiveListeners.push(listener);
  }

  onSiteArchiveExternalLink(listener: (url: string) => void): void {
    this.externalLinkListeners.push(listener);
  }

  /**
   * Test-only escape hatch (see testHooks.ts): Playwright can't attach to
   * WebContentsView content directly, so e2e tests that need to simulate
   * in-page interaction (e.g. an SPA's history.pushState route change) run
   * a script through the main process instead of clicking inside the tab.
   */
  async executeJavaScriptInTabForTesting(tabId: string, script: string): Promise<unknown> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Tab not found');
    return tab.view.webContents.executeJavaScript(script, true);
  }

  createTab(url: string | undefined, isPrivate: boolean): string {
    const partition = isPrivate ? `private-${crypto.randomUUID()}` : 'persist:browsing';
    const sess = session.fromPartition(partition, { cache: !isPrivate });

    if (!configuredSessions.has(partition)) {
      installPermissionHandlers(sess, this.settings);
      sess.on('will-download', (event, item, webContents) => this.handleDownload(event, item, webContents));
      // Never let a page choose an arbitrary local path or reach devtools/file targets via redirects to internal schemes.
      sess.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith('file://') || details.url.startsWith('archive://')) {
          callback({ cancel: true });
          return;
        }
        callback({ cancel: false });
      });
      configuredSessions.add(partition);
    }

    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
        devTools: true,
      },
    });

    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      view,
      isPrivate,
      isArchivingPaused: false,
      previousUrl: null,
      lastCaptureStatus: null,
      favicon: null,
      kind: 'live',
      offlineArchiveId: null,
      pendingOriginalUrl: null,
    };
    this.tabs.set(id, tab);
    this.wireEvents(tab);

    this.mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    const target = url ? resolveAddressBarInput(url, this.settings.get().searchEngineUrlTemplate) : 'about:blank';
    tab.pendingOriginalUrl = target;
    void view.webContents.loadURL(target);

    this.emitState(tab);
    return id;
  }

  /**
   * Open an archived page for fully offline viewing: dedicated session
   * with network access blocked (see offlineSession.ts), JS disabled.
   * Screenshot/text/fallback content is served through the archive://
   * protocol (see offlineProtocol.ts); the MHTML snapshot itself is loaded
   * via `loadFile()` on `mhtmlFilePath` instead. This is a deliberate,
   * narrow exception to "prefer a custom protocol over file://": Chromium's
   * MHTML archive loader only recognizes a document as MHTML when it's
   * fetched via file: (or a small set of built-in schemes) -- serving the
   * exact same bytes with the exact same multipart/related + boundary
   * Content-Type through our own protocol.handle() response is accepted at
   * the network layer but Chromium still fails it with ERR_FAILED before
   * ever reaching the archive/MHTML document loader, confirmed by testing
   * both paths directly. `mhtmlFilePath` is not attacker- or page-
   * influenced -- it's built by the caller via archiveDirFor()/
   * archiveFilePaths() from a server-generated UUID, so this doesn't
   * reopen arbitrary filesystem access; it's `loadFile()` given one
   * specific, pre-validated path, on a session that still has no network
   * access and JavaScript disabled.
   */
  openOfflineTab(
    archiveId: string,
    offlineSession: Electron.Session,
    hasMhtml: boolean,
    mhtmlFilePath: string,
    integrityFailed = false,
  ): string {
    const view = new WebContentsView({
      webPreferences: {
        session: offlineSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: false,
        images: true,
      },
    });

    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      view,
      isPrivate: false,
      isArchivingPaused: true,
      previousUrl: null,
      lastCaptureStatus: null,
      favicon: null,
      kind: 'offline',
      offlineArchiveId: archiveId,
      pendingOriginalUrl: null,
    };
    this.tabs.set(id, tab);

    view.webContents.on('did-start-loading', () => this.emitState(tab));
    view.webContents.on('did-stop-loading', () => this.emitState(tab));
    view.webContents.on('page-title-updated', () => this.emitState(tab));
    let fallenBack = !hasMhtml;
    view.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (!fallenBack) {
        fallenBack = true;
        void view.webContents.loadURL(`archive://${archiveId}/__fallback__`);
      }
    });
    // Offline archives never navigate anywhere else -- there is nothing to
    // click through to except what's already in the same MHTML snapshot.
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('did-navigate', () => this.emitState(tab));

    this.mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    const fallbackUrl = `archive://${archiveId}/__fallback__${integrityFailed ? '?reason=integrity' : ''}`;
    const initialLoad = hasMhtml ? view.webContents.loadFile(mhtmlFilePath) : view.webContents.loadURL(fallbackUrl);
    initialLoad.catch((err) => {
      logger.error('offline_tab.load_failed', { archiveId, error: err instanceof Error ? err.message : String(err) });
    });

    this.emitState(tab);
    return id;
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.captureService.disposeTab(id);
    this.mainWindow.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.delete(id);
    if (this.activeTabId === id) this.activeTabId = null;
    for (const l of this.closedListeners) l(id);
  }

  onTabActivated(listener: (tabId: string) => void): void {
    this.activatedListeners.push(listener);
  }

  activateTab(id: string): void {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    // Main can activate a tab on its own (opening a .sitearchive, a
    // popup, "Open Live Version"), so the renderer has to be told --
    // otherwise its toolbar would keep acting on the previously active tab.
    for (const l of this.activatedListeners) l(id);
    for (const [tabId, tab] of this.tabs) {
      tab.view.setBounds(tabId === id ? this.contentBounds : { x: 0, y: 0, width: 0, height: 0 });
    }
    const tab = this.tabs.get(id);
    if (tab) this.emitState(tab);
  }

  setContentBounds(bounds: Rectangle): void {
    this.contentBounds = bounds;
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) tab.view.setBounds(bounds);
    }
  }

  navigate(id: string, input: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const target = resolveAddressBarInput(input, this.settings.get().searchEngineUrlTemplate);
    tab.pendingOriginalUrl = target;
    void tab.view.webContents.loadURL(target);
  }

  goBack(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents;
    if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents;
    if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(id: string): void {
    this.tabs.get(id)?.view.webContents.reload();
  }

  stop(id: string): void {
    this.tabs.get(id)?.view.webContents.stop();
  }

  setArchivingPaused(id: string, paused: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.isArchivingPaused = paused;
    this.emitState(tab);
  }

  private handleDownload(
    event: Electron.Event,
    item: Electron.DownloadItem,
    _webContents: Electron.WebContents,
  ): void {
    // Explicit save-location prompt for every download, synchronously, so
    // the item can be redirected before Electron picks a default path.
    const result = dialog.showSaveDialogSync(this.mainWindow, {
      defaultPath: item.getFilename(),
    });
    if (!result) {
      item.cancel();
      return;
    }
    item.setSavePath(result);
    item.once('done', (_e, state) => {
      logger.info('download.done', { state });
    });
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (!isSafeRemoteUrl(url)) {
        logger.warn('popup.blocked_unsafe_scheme', {});
        return { action: 'deny' };
      }
      this.createTab(url, tab.isPrivate);
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      if (url === 'about:blank') return;
      if (!isSafeRemoteUrl(url)) {
        event.preventDefault();
        logger.warn('navigation.blocked_unsafe_scheme', {});
        return;
      }
      // Only page/link-initiated navigations reach here (our own
      // navigate()/createTab() calls already set pendingOriginalUrl
      // directly before calling loadURL). Redirects fire 'will-redirect',
      // not 'will-navigate', so this stays the pre-redirect URL.
      tab.pendingOriginalUrl = url;
    });

    wc.on('will-redirect', (event, url) => {
      if (!isSafeRemoteUrl(url)) {
        event.preventDefault();
        logger.warn('navigation.blocked_unsafe_redirect', {});
      }
    });

    wc.on('did-start-loading', () => this.emitState(tab));
    wc.on('did-stop-loading', () => this.emitState(tab));

    wc.on('did-fail-load', (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED, e.g. user navigated away
      this.emitState(tab);
    });

    wc.on('page-title-updated', () => this.emitState(tab));
    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] ?? null;
      this.emitState(tab);
    });

    wc.on('did-navigate', (_event, url, _httpResponseCode) => {
      this.emitState(tab);
      void this.recordTopLevelNavigation(tab, url);
    });

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.emitState(tab);
      const referrer = tab.previousUrl;
      tab.previousUrl = url;
      this.captureService.notifyInPageNavigation(wc, tab.id, url, referrer, tab.isPrivate, tab.isArchivingPaused);
    });

    wc.on('render-process-gone', (_event, details) => {
      logger.error('renderer.process_gone', { reason: details.reason });
    });
  }

  private async recordTopLevelNavigation(tab: Tab, finalUrl: string): Promise<void> {
    const wc = tab.view.webContents;
    const referrer = tab.previousUrl ?? (await safeDocumentReferrer(wc));
    const originalUrl = tab.pendingOriginalUrl ?? finalUrl;
    tab.previousUrl = finalUrl;
    tab.pendingOriginalUrl = null;
    this.captureService.notifyTopLevelNavigation(wc, {
      tabId: tab.id,
      originalUrl,
      referrerUrl: referrer || null,
      visitedAt: new Date().toISOString(),
      isPrivate: tab.isPrivate,
      isArchivingPaused: tab.isArchivingPaused,
    });
    logger.info('navigation.top_level', { domain: redactUrl(finalUrl) });
  }

  private emitState(tab: Tab): void {
    const state = this.toTabState(tab);
    for (const l of this.stateListeners) l(state);
  }

  private toTabState(tab: Tab): TabState {
    const wc = tab.view.webContents;
    const destroyed = wc.isDestroyed();
    return {
      id: tab.id,
      url: destroyed ? '' : wc.getURL(),
      title: destroyed ? '' : wc.getTitle(),
      favicon: tab.favicon,
      isLoading: !destroyed && wc.isLoading(),
      canGoBack: !destroyed && wc.navigationHistory.canGoBack(),
      canGoForward: !destroyed && wc.navigationHistory.canGoForward(),
      isPrivate: tab.isPrivate,
      isArchivingPaused: tab.isArchivingPaused,
      lastCaptureStatus: tab.lastCaptureStatus,
      isOffline: tab.kind === 'offline' || tab.kind === 'sitearchive',
      offlineArchiveId: tab.offlineArchiveId,
      isSiteArchive: tab.kind === 'sitearchive',
      siteArchiveTitle: tab.siteArchiveTitle ?? null,
      siteArchivePath: tab.siteArchivePath ?? null,
    };
  }
}

async function safeDocumentReferrer(wc: Electron.WebContents): Promise<string> {
  try {
    if (wc.isDestroyed()) return '';
    const result = await wc.executeJavaScript('document.referrer', true);
    return typeof result === 'string' ? result : '';
  } catch {
    return '';
  }
}

/** Open a URL with the OS default handler only for schemes we've validated. */
export function openExternalSafely(url: string): void {
  if (!isSafeExternalUrl(url)) {
    logger.warn('external_open.blocked_unsafe_scheme', {});
    return;
  }
  void shell.openExternal(url);
}
