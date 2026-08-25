import type { SettingsStore } from '../settings/settingsStore';
import type { CaptureService } from '../capture/captureService';
import { TabManager } from '../browser/tabManager';
import { createMainWindow } from './mainWindow';
import { registerWindow, unregisterWindow, allEntries, type AppWindowEntry } from './windowRegistry';
import { Channels } from '../../shared/ipcContract';

export interface AppWindowDeps {
  settings: SettingsStore;
  captureService: CaptureService;
  /**
   * Called when the last chrome window has just closed. Deliberately not
   * Electron's own 'window-all-closed' event: once a capture has ever run,
   * the hidden capture-host window (see captureHostWindow.ts) is itself a
   * live BrowserWindow, so "all windows closed" from Electron's point of
   * view would stop being true the moment a chrome window count of zero is
   * exactly the condition this app actually cares about.
   */
  onAllWindowsClosed: () => void;
}

/**
 * Creates one independent chrome window: its own BrowserWindow, its own
 * TabManager (and therefore its own tab strip, address bar, Library, and
 * Settings -- each window's renderer is a fresh instance of the same app),
 * registered so IPC handlers, the app menu, and broadcast events (update
 * status, etc.) can find it. Called once at startup for the first window,
 * and again for every "New Window" / dock-reactivate-with-none-open.
 */
export function createAppWindow(deps: AppWindowDeps): AppWindowEntry {
  const window = createMainWindow();
  const tabManager = new TabManager(window, deps.settings, deps.captureService);

  tabManager.onTabState((state) => {
    if (!window.isDestroyed()) window.webContents.send(Channels.onTabState, state);
  });
  tabManager.onTabClosed((tabId) => {
    if (!window.isDestroyed()) window.webContents.send(Channels.onTabClosed, tabId);
  });
  tabManager.onTabActivated((tabId) => {
    if (!window.isDestroyed()) window.webContents.send(Channels.onTabActivated, tabId);
  });
  // An archived page can't use IPC, so "Open Live Version" and external
  // links surface here and are routed to this same window's renderer,
  // which confirms and re-invokes the corresponding IPC handler.
  tabManager.onSiteArchiveOpenLive((url) => {
    if (!window.isDestroyed()) {
      window.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'open-live', url });
    }
  });
  tabManager.onSiteArchiveExternalLink((url) => {
    if (!window.isDestroyed()) {
      window.webContents.send(Channels.onSiteArchiveOpenRequest, { kind: 'external', url });
    }
  });

  const entry: AppWindowEntry = { window, tabManager };
  registerWindow(window, tabManager);

  // Tabs must be torn down (and capture bookkeeping released) while the
  // window -- and thus each tab's parent contentView -- still exists;
  // 'closed' fires after destruction, so this runs on 'close' instead.
  window.on('close', () => tabManager.disposeAll());
  window.on('closed', () => {
    unregisterWindow(window.id);
    if (allEntries().length === 0) deps.onAllWindowsClosed();
  });

  const firstTabId = tabManager.createTab(undefined, false);
  tabManager.activateTab(firstTabId);

  return entry;
}
