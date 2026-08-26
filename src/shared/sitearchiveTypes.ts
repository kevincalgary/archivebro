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

export type CaptureScopeKind =
  | 'current-page'
  | 'entire-site'
  | 'custom'
  | 'forum-thread'
  | 'forum-section'
  | 'forum-whole';

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
  /**
   * Forum-only toggles, consulted when `kind` is one of the `forum-*`
   * kinds. Absent/undefined is treated the same as the documented default
   * for non-forum scopes and for archives captured before these existed.
   */
  /** Follow links to member/author profile pages. Off by default -- profiles balloon a capture without being thread content. */
  forumIncludeProfiles?: boolean;
  /** Download linked attachments (files without a browser-rendered preview) as assets. */
  forumDownloadAttachments?: boolean;
  /** Fetch images hosted on a different origin than the forum itself. */
  forumAttemptExternalImages?: boolean;
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

/** Default forum toggles, shared by all three forum-flavored presets below. */
const DEFAULT_FORUM_TOGGLES = {
  forumIncludeProfiles: false,
  forumDownloadAttachments: true,
  forumAttemptExternalImages: true,
};

export const DEFAULT_FORUM_THREAD_SCOPE: CaptureScope = {
  ...DEFAULT_CAPTURE_SCOPE,
  ...DEFAULT_FORUM_TOGGLES,
  kind: 'forum-thread',
  maxDepth: null,
  maxPages: 500,
};

export const DEFAULT_FORUM_SECTION_SCOPE: CaptureScope = {
  ...DEFAULT_CAPTURE_SCOPE,
  ...DEFAULT_FORUM_TOGGLES,
  kind: 'forum-section',
  maxDepth: null,
  maxPages: 2000,
};

export const DEFAULT_FORUM_WHOLE_SCOPE: CaptureScope = {
  ...DEFAULT_CAPTURE_SCOPE,
  ...DEFAULT_FORUM_TOGGLES,
  kind: 'forum-whole',
  maxDepth: 12,
  maxPages: 20_000,
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
  /** Set only for pages captured under a forum-* scope. Identity of the thread this page belongs to, shared across every page of that thread's pagination. */
  forumThreadKey?: string;
  /** Identity of the forum section this page belongs to, when known. */
  forumSectionKey?: string;
  /** 1-based position of this page within its thread's pagination, when known. */
  forumPageIndex?: number;
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
  /** A link that isn't part of the selected forum scope (e.g. another thread, outside a "current thread" capture). */
  | 'skipped-out-of-forum-scope'
  /** An attachment link found, but `forumDownloadAttachments` was off. */
  | 'skipped-attachment-excluded'
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

/**
 * One forum post, extracted best-effort from a page captured under a
 * forum-* scope. Detection is heuristic (see forumPageScript.ts) -- a page
 * with no recognizable post markup simply contributes zero entries here
 * and is still indexed at whole-page granularity via pages_fts, so search
 * never silently loses coverage.
 */
export interface ForumPostEntry {
  /** Stable id, derived from the page + the post's in-page anchor. */
  postId: string;
  pageId: string;
  /** Element id inside the captured page this post can be scrolled to, e.g. "post-123". */
  anchor: string;
  author: string | null;
  authorProfileUrl: string | null;
  /** ISO timestamp when recoverable from a <time datetime> attribute, else null. */
  timestamp: string | null;
  postNumber: number | null;
  threadKey: string;
  sectionKey: string | null;
  threadTitle: string;
  sectionTitle: string | null;
}

/** Aggregate forum stats, present only on archives captured under a forum-* scope. */
export interface ForumCaptureSummary {
  sectionCount: number;
  threadCount: number;
  postCount: number;
  attachmentCount: number;
  profileCount: number;
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
  /** Present only when scope.kind was a forum-* kind. */
  forumPosts?: ForumPostEntry[];
  forumSummary?: ForumCaptureSummary;
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
  /** Threads captured so far, under a forum-* scope. Undefined for non-forum captures. */
  threadsSaved?: number;
  /** Images/attachments/other non-page assets saved so far. Undefined for non-forum captures. */
  imagesSaved?: number;
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
  forumSummary?: ForumCaptureSummary;
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
  /** Element id to scroll to on the destination page, when the match is anchor-addressable. */
  anchor?: string;
}

/** One match from searching forum posts inside an open .sitearchive (see OpenedArchive.searchForumPosts()). */
export interface ForumPostSearchResult {
  postId: string;
  pageId: string;
  anchor: string;
  author: string | null;
  threadTitle: string;
  sectionTitle: string | null;
  normalizedUrl: string;
  /** Plain text excerpt around the match, truncated -- no markup, safe to render as-is. */
  snippet: string;
}

/**
 * One row of the app-wide, persistent registry of completed `.sitearchive`
 * captures -- separate from the single-page auto-capture Library, since a
 * `.sitearchive` is a portable multi-page file with its own summary shape.
 * See siteArchiveHistoryRepo.ts.
 */
export interface SiteArchiveHistoryEntry {
  archiveId: string;
  outputPath: string;
  siteTitle: string;
  startUrl: string;
  scopeKind: CaptureScopeKind;
  capturedAt: string;
  pageCount: number;
  assetCount: number;
  fileSizeBytes: number;
  threadCount: number | null;
  sectionCount: number | null;
  attachmentCount: number | null;
  isComplete: boolean;
  incompleteReason: string | null;
  failureCount: number;
  /** False when `outputPath` no longer exists on disk -- the UI offers Remove instead of Open/Reveal. */
  fileExists: boolean;
}
