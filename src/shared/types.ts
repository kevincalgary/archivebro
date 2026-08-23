// Types shared between the main process and the trusted renderer.
// Nothing in this file is exposed to browsed or archived web content.

export type TabId = string;
export type ArchiveId = string;

export interface TabState {
  id: TabId;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isPrivate: boolean;
  isArchivingPaused: boolean;
  lastCaptureStatus: CaptureStatus | null;
  isOffline: boolean;
  offlineArchiveId: ArchiveId | null;
  /** True for tabs viewing a portable .sitearchive file. */
  isSiteArchive: boolean;
  siteArchiveTitle: string | null;
  siteArchivePath: string | null;
}

export type CaptureStatus =
  | 'idle'
  | 'pending'
  | 'capturing'
  | 'success'
  | 'failed'
  | 'skipped-excluded'
  | 'skipped-private'
  | 'skipped-non-http';

export interface CaptureWarning {
  code: string;
  message: string;
}

export interface ArchiveRecord {
  id: ArchiveId;
  canonicalUrl: string;
  originalUrl: string;
  finalUrl: string;
  title: string;
  domain: string;
  faviconPath: string | null;
  referrerUrl: string | null;
  capturedAt: string; // ISO timestamp, when the archive files were written
  visitedAt: string; // ISO timestamp, when the top-level navigation happened
  status: Exclude<CaptureStatus, 'idle' | 'pending' | 'capturing'>;
  warnings: CaptureWarning[];
  sizeBytes: number;
  appVersion: string;
  schemaVersion: number;
  tags: string[];
  notes: string | null;
  deleted: boolean;
}

export interface ArchiveDetail extends ArchiveRecord {
  hasMhtml: boolean;
  hasScreenshot: boolean;
  hasText: boolean;
  /** SHA-256 recorded at capture time, or null for archives predating this column. Verified on open/read. */
  mhtmlSha256: string | null;
  screenshotSha256: string | null;
  textSha256: string | null;
  versionCount: number;
}

export interface LibraryQuery {
  search?: string;
  domain?: string;
  status?: ArchiveRecord['status'];
  dateFrom?: string;
  dateTo?: string;
  sort?: 'newest' | 'oldest' | 'domain' | 'size';
  limit?: number;
  offset?: number;
}

export interface LibraryPage {
  items: ArchiveRecord[];
  total: number;
}

export interface AppSettings {
  autoCaptureEnabled: boolean;
  captureDelayMs: number;
  archiveStorageDir: string;
  maxDiskUsageMb: number | null; // null = unlimited
  retentionDays: number | null; // null = keep forever
  excludedDomains: string[];
  searchEngineUrlTemplate: string; // must contain %s
  screenshotQuality: number; // 0-100, PNG so mostly relevant for future JPEG option
  permissionDefaults: Record<PermissionKind, 'ask' | 'deny' | 'allow'>;
  /**
   * Off by default. When on, logs record full URLs instead of just the
   * origin. Useful for reporting a bug, but it means the log file on disk
   * contains the addresses of pages visited.
   */
  diagnosticLogging: boolean;
}

export type PermissionKind =
  | 'notifications'
  | 'geolocation'
  | 'camera'
  | 'microphone'
  | 'midi'
  | 'clipboard-read'
  | 'display-capture';

export interface DiskUsageInfo {
  totalBytes: number;
  archiveCount: number;
  quotaBytes: number | null;
}

export interface NavigationRequest {
  tabId: TabId;
  input: string;
}
