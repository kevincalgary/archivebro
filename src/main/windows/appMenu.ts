import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { TabManager } from '../browser/tabManager';
import { Channels } from '../../shared/ipcContract';
import { getFocusedEntry } from './windowRegistry';

/**
 * Standard browser shortcuts, mapped through Electron's 'CmdOrCtrl' /
 * 'CmdOrCtrl+Shift' accelerators so macOS gets Cmd and Windows gets Ctrl
 * automatically. Actions that operate on browser/tab state go straight to
 * the focused window's TabManager; actions that are purely a renderer UI
 * concern (focusing the address bar, switching screens) are pushed to that
 * window's renderer as a 'events:menuAction' message for the React UI to
 * handle. Built once for the whole app -- Electron's application menu is
 * process-global, not per-window -- so every click resolves "the window
 * this should act on" at click time rather than closing over one fixed
 * window/TabManager from when the menu was built.
 */
export function buildAppMenu(createWindow: () => void, checkForUpdates?: () => void): void {
  const send = (action: string) => getFocusedEntry()?.window.webContents.send(Channels.onMenuAction, action);
  /** Runs fn against the focused window's TabManager and its active tab id, if both exist. */
  const withActiveTab = (fn: (tabManager: TabManager, tabId: string) => void) => {
    const entry = getFocusedEntry();
    const id = entry?.tabManager.getActiveTabId();
    if (entry && id) fn(entry.tabManager, id);
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
      { label: 'New Private Tab', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-private-tab') },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => withActiveTab((_tabManager, id) => send(`close-tab:${id}`)),
      },
      { type: 'separator' },
      { label: 'Capture the Page…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('capture-page') },
      { label: 'Open Website Archive…', accelerator: 'CmdOrCtrl+O', click: () => send('open-sitearchive') },
      { type: 'separator' },
      { role: 'close' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => send('find-in-page') },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => withActiveTab((tabManager, id) => tabManager.reload(id)),
      },
      {
        label: 'Stop',
        accelerator: 'Esc',
        click: () => withActiveTab((tabManager, id) => tabManager.stop(id)),
      },
      { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => send('focus-address-bar') },
      { type: 'separator' },
      { label: 'Library', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('open-library') },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
    ],
  };

  const historyMenu: MenuItemConstructorOptions = {
    label: 'History',
    submenu: [
      {
        label: 'Back',
        accelerator: 'CmdOrCtrl+[',
        click: () => withActiveTab((tabManager, id) => tabManager.goBack(id)),
      },
      {
        label: 'Forward',
        accelerator: 'CmdOrCtrl+]',
        click: () => withActiveTab((tabManager, id) => tabManager.goForward(id)),
      },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }],
  };

  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({
      label: 'Archive Browser',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // Also available in Settings, for Windows/Linux (which have no app
        // menu) and anyone who'd rather not use the menu bar.
        { label: 'Check for Updates…', click: () => checkForUpdates?.() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(fileMenu, editMenu, viewMenu, historyMenu, windowMenu);

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
