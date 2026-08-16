// Types for the portable .sitearchive container format.
//
// A .sitearchive file is a ZIP container with a documented layout (not a
// proprietary blob) -- you can rename it to .zip and inspect it with any
// standard tool:
//
//   manifest.json          <- everything below, as JSON
//   pages/<pageId>.html    <- serialized rendered DOM per captured page
//   assets/<sha256>.<ext>  <- content-addressed, deduplicated
//   screenshots/<pageId>.png
//   responses/<sha256>.json <- safe captured GET responses (JSON/etc.)
//   index.sqlite           <- queryable catalog of the above
//
// The manifest is the authority: entries present in the ZIP but absent
// from the manifest are ignored when reading, and every manifest entry's
// SHA-256 is verified before its bytes are served.

export const SITEARCHIVE_FORMAT_VERSION = 1;
export const SITEARCHIVE_EXTENSION = 'sitearchive';

export type CaptureScopeKind = 'current-page' | 'entire-site' | 'custom';

export interface CaptureScope {
  kind: CaptureScopeKind;
  /** Max link depth from the starting page. 0 = starting page only. */
  maxDepth: number;
  maxPages: number;
  maxTotalBytes: number;
  /** Hostnames allowed in addition to the starting origin's host. */
  allowedDomains: string[];
  /** Explicitly opted-in external domains (assets/pages), beyond allowedDomains. */
  includeExternalDomains: string[];
  includeDocuments: boolean;
  includeMedia: boolean;
  /** Milliseconds between requests issued by a single worker. */
  crawlDelayMs: number;
  /** Number of pages fetched in parallel. Kept deliberately low. */
  concurrency: number;
}

export const DEFAULT_CAPTURE_SCOPE: CaptureScope = {
  kind: 'current-page',
  maxDepth: 0,
  maxPages: 1,
  maxTotalBytes: 256 * 1024 * 1024,
  allowedDomains: [],
  includeExternalDomains: [],
  includeDocuments: true,
  includeMedia: false,
  crawlDelayMs: 250,
  concurrency: 2,
};

export const DEFAULT_SITE_SCOPE: CaptureScope = {
  ...DEFAULT_CAPTURE_SCOPE,
  kind: 'entire-site',
  maxDepth: 3,
  maxPages: 50,
};

/** Hard ceilings the UI requires explicit confirmation to exceed. */
export const SCOPE_SOFT_LIMITS = {
  maxDepth: 5,
  maxPages: 200,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

/** Absolute ceilings that cannot be exceeded at all, to bound resource use. */
export const SCOPE_HARD_LIMITS = {
  maxDepth: 10,
  maxPages: 2000,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxConcurrency: 6,
} as const;

export interface ArchivedPageEntry {
  pageId: string;
  /** URL as discovered/requested, before redirects. */
  originalUrl: string;
  /** URL after redirects -- the identity of what was actually captured. */
  finalUrl: string;
  /** Normalized form of finalUrl, used for routing/dedupe. */
  normalizedUrl: string;
  title: string;
  depth: number;
  capturedAt: string;
  /** Zip path of the serialized DOM, e.g. "pages/<pageId>.html". */
  htmlPath: string;
  htmlSha256: string;
  screenshotPath: string | null;
  screenshotSha256: string | null;
  textPath: string | null;
  textSha256: string | null;
  /** Redirect chain that led here, if any (normalized URLs). */
  redirectedFrom: string[];
  contentType: string;
  byteSize: number;
}

export type AssetKind = 'stylesheet' | 'image' | 'font' | 'script' | 'media' | 'document' | 'other';

export interface ArchivedAssetEntry {
  sha256: string;
  /** Zip path, e.g. "assets/<sha256>.png". */
  path: string;
  contentType: string;
  byteSize: number;
  kind: AssetKind;
  /** Every original URL that resolved to these bytes (dedup can map many). */
  sourceUrls: string[];
  /** Present only for assets produced by the image screenshot fallback. */
  screenshotFallback?: ScreenshotFallbackMeta;
}

/**
 * Metadata recorded for an image that could not be archived normally and
 * was instead preserved by screenshotting its rendered appearance.
 */
export interface ScreenshotFallbackMeta {
  /** True for every asset carrying this metadata; explicit for readers. */
  isRenderedScreenshot: true;
  /** Original resource URL when known (absent for canvas/blob/generated). */
  originalUrl: string | null;
  /** Page the element was rendered on. */
  pageUrl: string;
  /** img | canvas | svg | video-poster | css-background | other */
  elementType: string;
  renderedWidth: number;
  renderedHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
  capturedAt: string;
  /** Why normal download/serialization failed. */
  reason: string;
}

export interface ArchivedResponseEntry {
  sha256: string;
  path: string;
  url: string;
  normalizedUrl: string;
  contentType: string;
  byteSize: number;
  /** Only ever 'GET' -- other methods are never captured or replayed. */
  method: 'GET';
  status: number;
}

export type CaptureFailureKind =
  | 'fetch-failed'
  | 'http-error'
  | 'timeout'
  | 'too-large'
  | 'skipped-scope'
  | 'skipped-non-http'
  | 'skipped-duplicate'
  | 'skipped-trap'
  | 'skipped-sensitive'
  | 'redirect-loop'
  | 'render-failed'
  | 'serialize-failed'
  | 'cancelled';

export interface CaptureFailureEntry {
  url: string;
  kind: CaptureFailureKind;
  message: string;
  /** Page the failing URL was discovered on, when known. */
  discoveredOn: string | null;
}

/**
 * Maps a normalized URL to what it resolves to inside the archive.
 * Used by the offline viewer to route link clicks without touching the network.
 */
export interface RouteMapEntry {
  normalizedUrl: string;
  target: { type: 'page'; pageId: string } | { type: 'asset'; sha256: string } | { type: 'response'; sha256: string };
}

export interface SiteArchiveManifest {
  formatVersion: number;
  archiveId: string;
  /** URL the capture was started from. */
  startUrl: string;
  /** Start URL after any redirects. */
  startFinalUrl: string;
  siteTitle: string;
  capturedAt: string;
  scope: CaptureScope;
  pages: ArchivedPageEntry[];
  assets: ArchivedAssetEntry[];
  responses: ArchivedResponseEntry[];
  routes: RouteMapEntry[];
  failures: CaptureFailureEntry[];
  appVersion: string;
  /** Sum of all uncompressed entry sizes, used for read-time bomb checks. */
  totalUncompressedBytes: number;
  /** Zip path + hash of the SQLite catalog, when present. */
  indexPath: string | null;
  indexSha256: string | null;
}

// --- Live capture progress (main -> renderer) ---

export type CaptureJobState = 'preparing' | 'running' | 'paused' | 'finalizing' | 'completed' | 'failed' | 'cancelled';

export interface CaptureProgress {
  jobId: string;
  state: CaptureJobState;
  siteTitle: string;
  startUrl: string;
  scopeKind: CaptureScopeKind;
  pagesDiscovered: number;
  pagesCompleted: number;
  currentUrl: string | null;
  bytesDownloaded: number;
  warningCount: number;
  failureCount: number;
  /** Populated once state is 'completed'. */
  result?: CaptureResult;
  /** Populated when state is 'failed'. */
  error?: string;
}

export interface CaptureResult {
  archivePath: string;
  pageCount: number;
  assetCount: number;
  fileSizeBytes: number;
  failures: CaptureFailureEntry[];
}

/** Summary returned when an archive is opened, for the UI header/details. */
export interface OpenedSiteArchive {
  archiveId: string;
  archivePath: string;
  siteTitle: string;
  startUrl: string;
  capturedAt: string;
  pageCount: number;
  assetCount: number;
  entryPageId: string;
  formatVersion: number;
  appVersion: string;
}
