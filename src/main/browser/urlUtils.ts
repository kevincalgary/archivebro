// URL parsing/validation shared by navigation, popups, and external-link
// handling. Nothing here trusts input from remote page content without
// re-validating it -- a page can ask us to navigate/open a URL, but it
// cannot get us to load an internal scheme (file:, chrome:, devtools:,
// archive:, our custom app scheme, etc.).

const ALLOWED_REMOTE_SCHEMES = new Set(['http:', 'https:']);

export function isSafeRemoteUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_REMOTE_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

/** For shell.openExternal targets (e.g. mailto: links a user explicitly clicked). */
const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_EXTERNAL_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

/**
 * Interpret address-bar / new-tab input the way a normal browser does:
 * a bare domain-looking string navigates directly, anything else becomes a
 * search query using the configured search engine.
 */
export function resolveAddressBarInput(input: string, searchEngineUrlTemplate: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';

  if (isSafeRemoteUrl(trimmed)) return trimmed;

  const looksLikeBareDomain = /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed) && !trimmed.includes(' ');
  if (looksLikeBareDomain) {
    const candidate = `https://${trimmed}`;
    if (isSafeRemoteUrl(candidate)) return candidate;
  }

  return buildSearchUrl(trimmed, searchEngineUrlTemplate);
}

export function buildSearchUrl(query: string, template: string): string {
  const encoded = encodeURIComponent(query);
  if (template.includes('%s')) return template.replace('%s', encoded);
  return `${template}${encoded}`;
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Canonical form used to group versions of "the same page": strip hash and trailing slash. */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/') {
      // keep root slash for domain-only URLs
    } else if (s.endsWith('/')) {
      s = s.slice(0, -1);
    }
    return s;
  } catch {
    return rawUrl;
  }
}
