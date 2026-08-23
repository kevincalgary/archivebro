// URL normalization, scope checks, and crawler-trap heuristics.
//
// Normalization exists so that two URLs that identify the same resource
// collapse to one archived page: "?utm_source=x" vs not, "#section" vs
// not, "/about/" vs "/about". This is deliberately conservative -- we only
// strip things that are safe to strip. Query strings that actually select
// content (?id=5, ?page=2) are preserved, because dropping them would
// merge genuinely different pages.

/** Tracking parameters that never change which resource is returned. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  '_ga',
  '_gl',
  'yclid',
  'twclid',
  'ttclid',
  'si',
]);

export interface NormalizeOptions {
  /** Keep the fragment (used only when we intentionally track anchors). */
  keepFragment?: boolean;
}

/**
 * Canonical string form used as the identity of a resource inside an
 * archive. Two URLs with the same normalized form are treated as the same
 * page/asset for dedupe and link routing.
 */
export function normalizeUrl(rawUrl: string, base?: string, options: NormalizeOptions = {}): string | null {
  let u: URL;
  try {
    u = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Host is case-insensitive; path is not.
  u.hostname = u.hostname.toLowerCase();

  // Drop the default port so http://x:80/ === http://x/
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  if (!options.keepFragment) u.hash = '';

  // Strip known tracking params, then sort the rest so parameter order
  // doesn't create duplicate captures of the same resource.
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  // Collapse a trailing slash on non-root paths: /about/ === /about
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

/** The fragment of a URL, or '' -- kept separately so anchors still work offline. */
export function fragmentOf(rawUrl: string, base?: string): string {
  try {
    const u = base ? new URL(rawUrl, base) : new URL(rawUrl);
    return u.hash;
  } catch {
    return '';
  }
}

export function isHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True if `candidate` is the same host as `base`, or a subdomain of it. */
export function isSameOriginOrSubdomain(candidate: string, baseHost: string): boolean {
  const host = hostOf(candidate);
  if (!host) return false;
  const b = baseHost.toLowerCase();
  return host === b || host.endsWith(`.${b}`);
}

export interface ScopeCheckInput {
  url: string;
  /** Origin (scheme://host[:port]) of the page the capture started from. */
  startOrigin: string;
  allowedDomains: string[];
  includeExternalDomains: string[];
}

/**
 * Whether a discovered URL is inside the capture scope.
 *
 * The default is strict *same-origin* -- scheme, host AND port must all
 * match, which is what "the same website" actually means and what stops a
 * site capture from walking off into the rest of the internet. A different
 * port on the same host is a different origin and is therefore out of
 * scope unless the user opts in.
 *
 * `allowedDomains` / `includeExternalDomains` widen this deliberately, and
 * those entries DO match subdomains (so allowing "example.com" covers
 * "cdn.example.com"), because that is the useful behavior when a user is
 * explicitly naming domains to include.
 */
export function isInScope(input: ScopeCheckInput): boolean {
  const { url, startOrigin, allowedDomains, includeExternalDomains } = input;
  if (!isHttpUrl(url)) return false;

  if (originOf(url) === startOrigin) return true;

  for (const d of [...allowedDomains, ...includeExternalDomains]) {
    const trimmed = d.trim().toLowerCase();
    if (trimmed && isSameOriginOrSubdomain(url, trimmed)) return true;
  }
  return false;
}

/** Link targets that look like state-changing actions -- never followed. */
const DESTRUCTIVE_PATH_RE =
  /\/(logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|reset|revoke|deactivate|purge|wipe|admin\/delete)(\/|$|\?)/i;
const DESTRUCTIVE_PARAM_RE = /\b(action|do|op|cmd)=(delete|remove|destroy|logout|signout|reset|purge)\b/i;

export function looksDestructive(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return DESTRUCTIVE_PATH_RE.test(u.pathname) || DESTRUCTIVE_PARAM_RE.test(u.search);
  } catch {
    return false;
  }
}

/**
 * Routes that are site plumbing rather than content: sign-in and account
 * flows, search endpoints, "start a new thread" forms, and per-user
 * profile pages.
 *
 * These matter because a page budget is finite. A forum front page offers
 * dozens of them (rangerovers.net: 21 member profiles and 22 utility
 * pages out of 86 links), and every one captured is a thread not
 * captured. None of them archive usefully either -- a login form or a
 * search box is inert offline.
 *
 * Deliberately narrow. Anything ambiguous is left crawlable, because
 * wrongly skipping real content is a worse failure than wasting a slot,
 * and every skip is recorded as a `skipped-non-content` failure so it is
 * visible in the archive rather than silent.
 */
const NON_CONTENT_PATH_RE =
  /(^|\/)(login|log-in|signin|sign-in|register|signup|sign-up|lostpassword|lost-password|forgot-password|search|members|member|profile|profiles|account|preferences|new-thread|create-thread|post-thread|new-topic|reply|subscribe|watched|bookmarks|conversations|notifications|cart|checkout)(\/|$)/i;
/** Query-driven equivalents, e.g. `?do=login` or `?action=search`. */
const NON_CONTENT_PARAM_RE = /\b(do|action|mode|view)=(login|register|search|newthread|newreply|profile|account)\b/i;

export function looksNonContent(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return NON_CONTENT_PATH_RE.test(u.pathname) || NON_CONTENT_PARAM_RE.test(u.search);
  } catch {
    return false;
  }
}

/**
 * Heuristics for classic crawler traps: infinite calendars, endlessly
 * generated query permutations, and pathological path repetition. These
 * are heuristics -- they bound worst-case crawls rather than guaranteeing
 * perfect classification, and every rejection is recorded as a
 * 'skipped-trap' failure so the user can see what was skipped.
 */
export function looksLikeCrawlerTrap(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }

  // Too many query parameters is a strong signal of generated permutations.
  if ([...u.searchParams.keys()].length > 12) return true;

  // Very long URLs are almost always generated.
  if (rawUrl.length > 2000) return true;

  const segments = u.pathname.split('/').filter(Boolean);

  // Deeply nested paths are typically generated recursion.
  if (segments.length > 20) return true;

  // The same segment repeated many times, e.g. /a/b/a/b/a/b/...
  const counts = new Map<string, number>();
  for (const s of segments) {
    const n = (counts.get(s) ?? 0) + 1;
    if (n >= 4) return true;
    counts.set(s, n);
  }

  // Calendar-style endless pagination: a date-ish path plus a date param.
  const hasCalendarPath = /\/(calendar|events?|schedule|archive)\//i.test(u.pathname);
  const hasDateParam = ['year', 'month', 'day', 'date', 'week', 'from', 'to'].some((p) => u.searchParams.has(p));
  if (hasCalendarPath && hasDateParam) return true;

  return false;
}

/** File extension (lowercased, no dot) implied by a URL path, or ''. */
export function extensionOf(rawUrl: string): string {
  try {
    const p = new URL(rawUrl).pathname;
    const base = p.slice(p.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'txt', 'zip']);
const MEDIA_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a']);

export function isDocumentUrl(rawUrl: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(rawUrl));
}

export function isMediaUrl(rawUrl: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(rawUrl));
}

/**
 * Extensions that are executables/installers. Links to these inside an
 * archive require explicit user confirmation before anything is opened.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'jar',
  'app', 'dmg', 'pkg', 'sh', 'bash', 'zsh', 'run', 'bin', 'deb', 'rpm', 'apk',
]);

export function isExecutableUrl(rawUrl: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extensionOf(rawUrl));
}
