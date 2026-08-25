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

/**
 * `null` on a limit means "no limit".
 *
 * Unlimited is a deliberate, explicit choice the user has to make -- the
 * presets are all bounded -- because an unbounded crawl of a large site
 * can run for a very long time and produce a very large file. Pause and
 * Cancel remain available throughout, and a free-disk-space floor is still
 * enforced regardless of these settings so an unlimited capture cannot
 * fill the drive.
 */
export type ScopeLimit = number | null;

export interface CaptureScope {
  kind: CaptureScopeKind;
  /** Max link depth from the starting page. 0 = starting page only, null = unlimited. */
  maxDepth: ScopeLimit;
  maxPages: ScopeLimit;
  maxTotalBytes: ScopeLimit;
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

/**
 * "Whole site, no limits" -- reachable from the scope dialog. Every bound
 * is removed except the non-bypassable free-disk-space floor, so this can
 * run for a long time on a large site. Pause and Cancel still work.
 */
export const UNLIMITED_SITE_SCOPE: CaptureScope = {
  ...DEFAULT_CAPTURE_SCOPE,
  kind: 'custom',
  maxDepth: null,
  maxPages: null,
  maxTotalBytes: null,
};

/** Hard ceilings the UI requires explicit confirmation to exceed. */
export const SCOPE_SOFT_LIMITS = {
  maxDepth: 5,
  maxPages: 200,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

/** Absolute ceilings that cannot be exceeded at all, to bound resource use. */
/**
 * Ceilings applied to *finite* values, so a typo like 999999999 pages is
 * clamped to something sane. Setting a limit to `null` (unlimited) bypasses
 * these entirely -- that is the escape hatch for capturing a whole large
 * site. `maxConcurrency` is never bypassable: it protects the target
 * server, not the user's disk.
 */
export const SCOPE_HARD_LIMITS = {
  maxDepth: 25,
  maxPages: 50_000,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
  maxConcurrency: 6,
} as const;

/** Free disk space that must remain available; enforced even when unlimited. */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;

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
  /** A route that is navigation or account plumbing, not archivable content. */
  | 'skipped-non-content'
  /** A resource whose fetch was abandoned because the page's time budget ran out. */
  | 'skipped-budget'
  /** The crawl hit a scope limit with pages still queued. */
  | 'stopped-at-limit'
  | 'redirect-loop'
  | 'render-failed'
  | 'serialize-failed'
  | 'cancelled'
  /** Dequeued for capture, then the process died before recording any outcome. */
  | 'interrupted';

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
  /** Distinguishes a fresh/resumed crawl from a resume-only retry of a finished archive's failed pages. */
  kind: 'capture' | 'retry';
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

/**
 * A staging tree from an interrupted capture, enriched with journal-replay
 * data for display. Returned by `captureRecovery:list` -- the recovery UI's
 * only source of this information; it never talks to the filesystem or the
 * checkpoint journal directly.
 */
export interface RecoverableCaptureSummary {
  archiveId: string;
  startUrl: string;
  outputPath: string;
  scopeKind: CaptureScopeKind;
  /** When the capture originally started (ISO timestamp). */
  startedAt: string;
  /** Most recent write anywhere in the staging tree -- when it actually stopped. */
  lastActivityMs: number;
  bytesOnDisk: number;
  pagesCompleted: number;
  pagesDiscovered: number;
  failureCount: number;
  /** False when finishing now would produce an archive with no pages to open. */
  canFinish: boolean;
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

/** One match from searching inside an open .sitearchive (see OpenedArchive.search()). */
export interface SiteArchiveSearchResult {
  pageId: string;
  title: string;
  normalizedUrl: string;
  /** Plain text excerpt around the match, truncated -- no markup, safe to render as-is. */
  snippet: string;
}
