import { contextBridge, ipcRenderer } from 'electron';
import { Channels } from '../shared/channels';
import type {
  AppSettings,
  ArchiveDetail,
  ArchiveRecord,
  CaptureStatus,
  DiskUsageInfo,
  LibraryPage,
  LibraryQuery,
  PermissionKind,
  TabState,
} from '../shared/types';
import type { CaptureProgress, CaptureScope, OpenedSiteArchive } from '../shared/sitearchiveTypes';

// This is the ONLY preload script in the app that calls contextBridge /
// ipcRenderer. It is attached exclusively to the trusted chrome window's
// webContents (see windows/mainWindow.ts). Browsing tabs and the offline
// archive viewer get no preload at all, so remote or archived page content
// never has any path to these APIs, directly or indirectly. Every call
// below is a thin, typed wrapper around ipcMain.handle channels that are
// independently validated on the main-process side (see ipc/handlers.ts).

const api = {
  tabs: {
    create: (url?: string): Promise<string> => ipcRenderer.invoke(Channels.tabsCreate, { url }),
    createPrivate: (url?: string): Promise<string> => ipcRenderer.invoke(Channels.tabsCreatePrivate, { url }),
    close: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsClose, { tabId }),
    activate: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsActivate, { tabId }),
    list: (): Promise<TabState[]> => ipcRenderer.invoke(Channels.tabsList),
    navigate: (tabId: string, input: string): Promise<void> => ipcRenderer.invoke(Channels.tabsNavigate, { tabId, input }),
    goBack: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsGoBack, { tabId }),
    goForward: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsGoForward, { tabId }),
    reload: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsReload, { tabId }),
    stop: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.tabsStop, { tabId }),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }): Promise<void> =>
      ipcRenderer.invoke(Channels.tabsSetBounds, bounds),
    setArchivingPaused: (tabId: string, paused: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.tabsToggleArchivePaused, { tabId, paused }),
  },
  library: {
    query: (q: LibraryQuery): Promise<LibraryPage> => ipcRenderer.invoke(Channels.libraryQuery, q),
    getDetail: (archiveId: string): Promise<ArchiveDetail | null> => ipcRenderer.invoke(Channels.libraryGetDetail, { archiveId }),
    getVersions: (canonicalUrl: string): Promise<ArchiveRecord[]> =>
      ipcRenderer.invoke(Channels.libraryGetVersions, { canonicalUrl }),
    rename: (archiveId: string, title: string): Promise<void> => ipcRenderer.invoke(Channels.libraryRename, { archiveId, title }),
    tag: (archiveId: string, tags: string[]): Promise<void> => ipcRenderer.invoke(Channels.libraryTag, { archiveId, tags }),
    delete: (archiveId: string): Promise<void> => ipcRenderer.invoke(Channels.libraryDelete, { archiveId }),
    deleteByDomain: (domain: string): Promise<{ deletedCount: number }> =>
      ipcRenderer.invoke(Channels.libraryDeleteByDomain, { domain }),
    export: (archiveId: string): Promise<{ exported: boolean; path?: string }> =>
      ipcRenderer.invoke(Channels.libraryExport, { archiveId }),
    revealInFolder: (archiveId: string): Promise<{ dir: string }> => ipcRenderer.invoke(Channels.libraryRevealInFolder, { archiveId }),
    openOffline: (archiveId: string): Promise<string> => ipcRenderer.invoke(Channels.libraryOpenOffline, { archiveId }),
    openLive: (archiveId: string): Promise<string> => ipcRenderer.invoke(Channels.libraryOpenLive, { archiveId }),
    findArchiveForUrl: (url: string): Promise<ArchiveRecord | null> =>
      ipcRenderer.invoke(Channels.libraryFindArchiveForUrl, { url }),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(Channels.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(Channels.settingsUpdate, patch),
    pickStorageDir: (): Promise<AppSettings | null> => ipcRenderer.invoke(Channels.settingsPickStorageDir),
    clearBrowsingData: (): Promise<void> => ipcRenderer.invoke(Channels.settingsClearBrowsingData),
    clearArchiveData: (): Promise<void> => ipcRenderer.invoke(Channels.settingsClearArchiveData),
    export: (): Promise<{ exported: boolean }> => ipcRenderer.invoke(Channels.settingsExport),
    import: (): Promise<{ imported: boolean }> => ipcRenderer.invoke(Channels.settingsImport),
    getDiskUsage: (): Promise<DiskUsageInfo> => ipcRenderer.invoke(Channels.settingsGetDiskUsage),
  },
  downloads: {
    chooseSavePath: (suggestedName: string): Promise<string | null> =>
      ipcRenderer.invoke(Channels.downloadsChooseSavePath, { suggestedName }),
  },
  permissions: {
    respond: (input: {
      requestId: string;
      allow: boolean;
      remember?: boolean;
      permissionKind: PermissionKind;
    }): Promise<{ resolved: boolean }> => ipcRenderer.invoke(Channels.permissionRespond, input),
  },
  siteCapture: {
    estimate: (tabId: string): Promise<{ url: string; title: string; host: string; canCapture: boolean; isBusy: boolean }> =>
      ipcRenderer.invoke(Channels.siteCaptureEstimate, { tabId }),
    start: (tabId: string, scope: CaptureScope): Promise<{ started: boolean; jobId?: string; outputPath?: string }> =>
      ipcRenderer.invoke(Channels.siteCaptureStart, { tabId, scope }),
    pause: (jobId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.siteCapturePause, { jobId }),
    resume: (jobId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.siteCaptureResume, { jobId }),
    cancel: (jobId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.siteCaptureCancel, { jobId }),
  },
  siteArchive: {
    open: (): Promise<OpenedSiteArchive | null> => ipcRenderer.invoke(Channels.siteArchiveOpen),
    openPath: (archivePath: string): Promise<OpenedSiteArchive> =>
      ipcRenderer.invoke(Channels.siteArchiveOpenPath, { archivePath }),
    revealInFolder: (archivePath: string): Promise<{ revealed: boolean }> =>
      ipcRenderer.invoke(Channels.siteArchiveRevealInFolder, { archivePath }),
    openLive: (url: string): Promise<{ opened: boolean; reason?: string }> =>
      ipcRenderer.invoke(Channels.siteArchiveOpenLive, { url }),
    confirmExternal: (url: string): Promise<{ opened: boolean; reason?: string }> =>
      ipcRenderer.invoke(Channels.siteArchiveConfirmExternal, { url }),
  },
  events: {
    onTabState: (cb: (state: TabState) => void) => subscribe<TabState>(Channels.onTabState, cb),
    onTabClosed: (cb: (tabId: string) => void) => subscribe<string>(Channels.onTabClosed, cb),
    onTabActivated: (cb: (tabId: string) => void) => subscribe<string>(Channels.onTabActivated, cb),
    onCaptureStatus: (cb: (payload: { tabId: string; status: CaptureStatus; archiveId?: string }) => void) =>
      subscribe(Channels.onCaptureStatus, cb),
    onMenuAction: (cb: (action: string) => void) => subscribe<string>(Channels.onMenuAction, cb),
    onPermissionRequest: (
      cb: (request: { requestId: string; permission: PermissionKind; origin: string }) => void,
    ) => subscribe(Channels.onPermissionRequest, cb),
    onSiteCaptureProgress: (cb: (progress: CaptureProgress) => void) =>
      subscribe<CaptureProgress>(Channels.onSiteCaptureProgress, cb),
    onSiteArchiveOpenRequest: (
      cb: (payload: { kind: 'open-live' | 'external' | 'open-archive'; url?: string; path?: string }) => void,
    ) => subscribe(Channels.onSiteArchiveOpenRequest, cb),
  },
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('archiveBrowser', api);

export type ArchiveBrowserApi = typeof api;
