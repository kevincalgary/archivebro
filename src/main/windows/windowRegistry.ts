import type { BrowserWindow } from 'electron';
import type { TabManager } from '../browser/tabManager';

export interface AppWindowEntry {
  window: BrowserWindow;
  tabManager: TabManager;
}

/**
 * Every open trusted chrome window, keyed by BrowserWindow.id. Replaces the
 * single hardcoded `mainWindow` that used to be threaded through
 * TabManager, UpdateService, IPC handlers, and the app menu -- see the
 * multi-window plan. Never holds the hidden capture-host window (that one
 * is never a valid IPC sender or dialog parent, and shouldn't be a
 * candidate for "the focused window").
 */
const windows = new Map<number, AppWindowEntry>();

export function registerWindow(window: BrowserWindow, tabManager: TabManager): void {
  windows.set(window.id, { window, tabManager });
}

export function unregisterWindow(windowId: number): void {
  windows.delete(windowId);
}

export function getEntry(windowId: number | undefined | null): AppWindowEntry | undefined {
  if (windowId == null) return undefined;
  return windows.get(windowId);
}

export function allEntries(): AppWindowEntry[] {
  return [...windows.values()];
}

/**
 * The window to act on when a request isn't tied to a specific one (a menu
 * click, an "open this .sitearchive" request from a second app instance).
 * Falls back to the most recently registered window if nothing currently
 * has OS focus -- e.g. a menu click can itself briefly clear focus.
 */
export function getFocusedEntry(): AppWindowEntry | undefined {
  for (const entry of windows.values()) {
    if (entry.window.isFocused()) return entry;
  }
  return [...windows.values()].at(-1);
}

/** True only for a chrome window's own webContents -- never a tab's. */
export function isTrustedSenderId(webContentsId: number): boolean {
  for (const entry of windows.values()) {
    if (entry.window.webContents.id === webContentsId) return true;
  }
  return false;
}

/** Which window (if any) owns the tab behind this webContents id. */
export function findEntryForTabWebContents(webContentsId: number): AppWindowEntry | undefined {
  for (const entry of windows.values()) {
    if (entry.tabManager.ownsWebContents(webContentsId)) return entry;
  }
  return undefined;
}

/** Which window (if any) owns the given tab id. */
export function findEntryForTab(tabId: string): AppWindowEntry | undefined {
  for (const entry of windows.values()) {
    if (entry.tabManager.getTabInfo(tabId) !== null) return entry;
  }
  return undefined;
}

export function broadcast(send: (window: BrowserWindow) => void): void {
  for (const { window } of windows.values()) {
    if (!window.isDestroyed()) send(window);
  }
}
