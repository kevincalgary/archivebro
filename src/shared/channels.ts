// Single source of truth for every IPC channel the trusted renderer is
// allowed to call. Split out from ipcContract.ts (which adds zod schemas
// per channel) so the preload bundle -- which only needs the channel name
// constants, not the validation schemas -- doesn't have to pull `zod` into
// its bundle. The preload script (src/preload/trusted-preload.ts) is the
// only place these channel names are wired to window.archiveBrowser; no
// other channel is ever registered, and no browsed/archived content ever
// gets a preload that touches ipcRenderer.

export const Channels = {
  // Tabs / navigation
  tabsCreate: 'tabs:create',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
  tabsList: 'tabs:list',
  tabsNavigate: 'tabs:navigate',
  tabsGoBack: 'tabs:goBack',
  tabsGoForward: 'tabs:goForward',
  tabsReload: 'tabs:reload',
  tabsStop: 'tabs:stop',
  tabsSetBounds: 'tabs:setBounds',
  tabsToggleArchivePaused: 'tabs:toggleArchivePaused',
  tabsCreatePrivate: 'tabs:createPrivate',

  // Events pushed main -> renderer
  onTabState: 'events:tabState',
  onTabClosed: 'events:tabClosed',
  onTabActivated: 'events:tabActivated',
  onCaptureStatus: 'events:captureStatus',
  onPermissionRequest: 'events:permissionRequest',
  onMenuAction: 'events:menuAction',

  // Library
  libraryQuery: 'library:query',
  libraryGetDetail: 'library:getDetail',
  libraryGetVersions: 'library:getVersions',
  libraryRename: 'library:rename',
  libraryTag: 'library:tag',
  libraryDelete: 'library:delete',
  libraryDeleteByDomain: 'library:deleteByDomain',
  libraryExport: 'library:export',
  libraryRevealInFolder: 'library:revealInFolder',
  libraryOpenOffline: 'library:openOffline',
  libraryOpenLive: 'library:openLive',
  libraryFindArchiveForUrl: 'library:findArchiveForUrl',

  // Settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickStorageDir: 'settings:pickStorageDir',
  settingsClearBrowsingData: 'settings:clearBrowsingData',
  settingsClearArchiveData: 'settings:clearArchiveData',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsGetDiskUsage: 'settings:getDiskUsage',

  // Permission responses (renderer answers a permission prompt raised by main)
  permissionRespond: 'permission:respond',

  // Downloads
  downloadsChooseSavePath: 'downloads:chooseSavePath',

  // Portable .sitearchive capture + viewing
  siteCaptureEstimate: 'siteCapture:estimate',
  siteCaptureStart: 'siteCapture:start',
  siteCapturePause: 'siteCapture:pause',
  siteCaptureResume: 'siteCapture:resume',
  siteCaptureCancel: 'siteCapture:cancel',
  siteCaptureRetryFailed: 'siteCapture:retryFailed',
  siteArchiveOpen: 'siteArchive:open',
  siteArchiveOpenPath: 'siteArchive:openPath',
  siteArchiveRevealInFolder: 'siteArchive:revealInFolder',
  siteArchiveOpenLive: 'siteArchive:openLive',
  siteArchiveConfirmExternal: 'siteArchive:confirmExternal',
  siteArchiveSearch: 'siteArchive:search',
  siteArchiveNavigateToPage: 'siteArchive:navigateToPage',

  // Recovering an interrupted .sitearchive capture (distinct from
  // siteCapture:pause/resume, which toggle a *running* job's pause state --
  // these act on a capture that already stopped, identified by archiveId).
  captureRecoveryList: 'captureRecovery:list',
  captureRecoveryResume: 'captureRecovery:resume',
  captureRecoveryFinish: 'captureRecovery:finish',
  captureRecoveryDiscard: 'captureRecovery:discard',

  // Events pushed main -> renderer for capture/archives
  onSiteCaptureProgress: 'events:siteCaptureProgress',
  onSiteArchiveOpenRequest: 'events:siteArchiveOpenRequest',

  // Auto-update (electron-updater). checkNow is always allowed regardless
  // of settings.autoUpdateCheckEnabled -- an explicit click is its own
  // consent; that setting only gates the unattended startup/periodic check.
  updatesCheckNow: 'updates:checkNow',
  updatesInstallNow: 'updates:installNow',
  updatesGetStatus: 'updates:getStatus',
  onUpdateStatus: 'events:updateStatus',
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];
