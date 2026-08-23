import { z } from 'zod';
import { Channels, type ChannelName } from './channels';
export { Channels, type ChannelName } from './channels';

// zod schema for each channel's arguments, validated by every
// ipcMain.handle call in src/main/ipc/handlers.ts before touching disk, a
// session, or a webContents. Kept in a separate file from the channel name
// constants (channels.ts) so the preload bundle -- which only needs the
// names, not zod -- doesn't pull the validation library into its bundle.

const nonEmptyString = z.string().min(1).max(4096);
const tabId = z.string().uuid();

const captureScopeSchema = z.object({
  kind: z.enum(['current-page', 'entire-site', 'custom']),
  // null means "no limit"; finite values are additionally clamped to
  // SCOPE_HARD_LIMITS in CaptureManager.clampScope.
  maxDepth: z.number().int().min(0).max(25).nullable(),
  maxPages: z.number().int().min(1).max(50_000).nullable(),
  maxTotalBytes: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024 * 1024).nullable(),
  allowedDomains: z.array(z.string().max(255)).max(100),
  includeExternalDomains: z.array(z.string().max(255)).max(100),
  includeDocuments: z.boolean(),
  includeMedia: z.boolean(),
  crawlDelayMs: z.number().int().min(0).max(10_000),
  concurrency: z.number().int().min(1).max(6),
});
const archiveId = z.string().uuid();

export const IpcSchemas = {
  [Channels.tabsCreate]: z.object({ url: z.string().max(4096).optional() }),
  [Channels.tabsCreatePrivate]: z.object({ url: z.string().max(4096).optional() }),
  [Channels.tabsClose]: z.object({ tabId }),
  [Channels.tabsActivate]: z.object({ tabId }),
  [Channels.tabsList]: z.void(),
  [Channels.tabsNavigate]: z.object({ tabId, input: nonEmptyString }),
  [Channels.tabsGoBack]: z.object({ tabId }),
  [Channels.tabsGoForward]: z.object({ tabId }),
  [Channels.tabsReload]: z.object({ tabId }),
  [Channels.tabsStop]: z.object({ tabId }),
  [Channels.tabsSetBounds]: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
  }),
  [Channels.tabsToggleArchivePaused]: z.object({ tabId, paused: z.boolean() }),

  [Channels.libraryQuery]: z.object({
    search: z.string().max(512).optional(),
    domain: z.string().max(255).optional(),
    status: z
      .enum(['success', 'failed', 'skipped-excluded', 'skipped-private', 'skipped-non-http'])
      .optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    sort: z.enum(['newest', 'oldest', 'domain', 'size']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  [Channels.libraryGetDetail]: z.object({ archiveId }),
  [Channels.libraryGetVersions]: z.object({ canonicalUrl: nonEmptyString }),
  [Channels.libraryRename]: z.object({ archiveId, title: z.string().max(500) }),
  [Channels.libraryTag]: z.object({ archiveId, tags: z.array(z.string().max(64)).max(32) }),
  [Channels.libraryDelete]: z.object({ archiveId }),
  [Channels.libraryDeleteByDomain]: z.object({ domain: nonEmptyString }),
  [Channels.libraryExport]: z.object({ archiveId }),
  [Channels.libraryRevealInFolder]: z.object({ archiveId }),
  [Channels.libraryOpenOffline]: z.object({ archiveId }),
  [Channels.libraryOpenLive]: z.object({ archiveId }),
  [Channels.libraryFindArchiveForUrl]: z.object({ url: nonEmptyString }),

  [Channels.settingsGet]: z.void(),
  [Channels.settingsUpdate]: z.object({
    autoCaptureEnabled: z.boolean().optional(),
    captureDelayMs: z.number().int().min(0).max(60_000).optional(),
    maxDiskUsageMb: z.number().int().min(0).nullable().optional(),
    retentionDays: z.number().int().min(0).nullable().optional(),
    excludedDomains: z.array(z.string().max(255)).max(2000).optional(),
    searchEngineUrlTemplate: z.string().max(2048).optional(),
    screenshotQuality: z.number().int().min(1).max(100).optional(),
    diagnosticLogging: z.boolean().optional(),
    permissionDefaults: z
      .record(z.string(), z.enum(['ask', 'deny', 'allow']))
      .optional(),
  }),
  [Channels.settingsPickStorageDir]: z.void(),
  [Channels.settingsClearBrowsingData]: z.void(),
  [Channels.settingsClearArchiveData]: z.void(),
  [Channels.settingsExport]: z.void(),
  [Channels.settingsImport]: z.void(),
  [Channels.settingsGetDiskUsage]: z.void(),

  [Channels.permissionRespond]: z.object({
    requestId: nonEmptyString,
    allow: z.boolean(),
    remember: z.boolean().optional(),
    permissionKind: z.enum([
      'notifications',
      'geolocation',
      'camera',
      'microphone',
      'midi',
      'clipboard-read',
      'display-capture',
    ]),
  }),

  [Channels.downloadsChooseSavePath]: z.object({ suggestedName: z.string().max(255) }),

  // --- Portable .sitearchive ---
  // Scope values are validated here AND clamped again in
  // CaptureManager.clampScope, so a malformed or hostile value can never
  // translate into an unbounded crawl.
  [Channels.siteCaptureEstimate]: z.object({ tabId }),
  [Channels.siteCaptureStart]: z.object({
    tabId,
    scope: captureScopeSchema,
  }),
  [Channels.siteCapturePause]: z.object({ jobId: nonEmptyString }),
  [Channels.siteCaptureResume]: z.object({ jobId: nonEmptyString }),
  [Channels.siteCaptureCancel]: z.object({ jobId: nonEmptyString }),
  [Channels.siteArchiveOpen]: z.void(),
  [Channels.siteArchiveOpenPath]: z.object({ archivePath: nonEmptyString }),
  [Channels.siteArchiveRevealInFolder]: z.object({ archivePath: nonEmptyString }),
  [Channels.siteArchiveOpenLive]: z.object({ url: nonEmptyString }),
  [Channels.siteArchiveConfirmExternal]: z.object({ url: nonEmptyString }),

  // --- Interrupted-capture recovery ---
  // archiveId is the only identifier accepted from the renderer; the main
  // process re-derives the staging directory from it (SiteArchiveBuilder.
  // stagingDirFor) rather than trusting any path the renderer supplies, so
  // a compromised or buggy renderer can never point these at an arbitrary
  // filesystem path.
  [Channels.captureRecoveryList]: z.void(),
  [Channels.captureRecoveryResume]: z.object({ archiveId }),
  [Channels.captureRecoveryFinish]: z.object({ archiveId }),
  [Channels.captureRecoveryDiscard]: z.object({ archiveId }),
} as const satisfies Partial<Record<ChannelName, z.ZodType>>;
