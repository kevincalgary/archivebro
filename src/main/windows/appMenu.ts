import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { TabManager } from '../browser/tabManager';
import { Channels } from '../../shared/ipcContract';

/**
 * Standard browser shortcuts, mapped through Electron's 'CmdOrCtrl' /
 * 'CmdOrCtrl+Shift' accelerators so macOS gets Cmd and Windows gets Ctrl
 * automatically. Actions that operate on browser/tab state go straight to
 * TabManager; actions that are purely a renderer UI concern (focusing the
 * address bar, switching screens) are pushed to the renderer as a
 * 'events:menuAction' message for the React UI to handle.
 */
export function buildAppMenu(mainWindow: BrowserWindow, tabManager: TabManager, checkForUpdates?: () => void): void {
  const send = (action: string) => mainWindow.webContents.send(Channels.onMenuAction, action);
  const activeTabId = () => tabManager.getActiveTabId();

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
      { label: 'New Private Tab', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-private-tab') },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => {
          const id = activeTabId();
          if (id) send(`close-tab:${id}`);
        },
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
        click: () => {
          const id = activeTabId();
          if (id) tabManager.reload(id);
        },
      },
      {
        label: 'Stop',
        accelerator: 'Esc',
        click: () => {
          const id = activeTabId();
          if (id) tabManager.stop(id);
        },
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
        click: () => {
          const id = activeTabId();
          if (id) tabManager.goBack(id);
        },
      },
      {
        label: 'Forward',
        accelerator: 'CmdOrCtrl+]',
        click: () => {
          const id = activeTabId();
          if (id) tabManager.goForward(id);
        },
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
