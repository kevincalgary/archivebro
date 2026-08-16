import { protocol, session, type Session } from 'electron';
import type { OpenedArchive } from './archiveReader';
import { ARCHIVE_SITE_SCHEME, SITEARCHIVE_PARTITION } from './constants';
import { normalizeUrl } from './urlNormalize';
import { logger } from '../util/logger';

/**
 * The archive-site:// protocol and its dedicated, network-blocked session.
 *
 * URL shape:  archive-site://<archiveId>/<entry-path>
 *             archive-site://<archiveId>/page/<pageId>
 *             archive-site://<archiveId>/__unavailable__?url=<original>
 *
 * Everything served here comes out of an OpenedArchive, which
 * checksum-verifies each entry against the manifest before returning its
 * bytes. The session blocks every request that is not this scheme, so an
 * archived page physically cannot reach the network even if it contains
 * scripts that try.
 */

const openArchives = new Map<string, OpenedArchive>();
let sessionInstance: Session | null = null;

/** Must be called before app.whenReady(). */
export function registerArchiveSiteSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARCHIVE_SITE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

export function registerOpenedArchive(archive: OpenedArchive): void {
  openArchives.set(archive.manifest.archiveId, archive);
}

export function getOpenedArchive(archiveId: string): OpenedArchive | null {
  return openArchives.get(archiveId) ?? null;
}

export function closeOpenedArchive(archiveId: string): void {
  const archive = openArchives.get(archiveId);
  if (!archive) return;
  archive.close();
  openArchives.delete(archiveId);
}

export function closeAllOpenedArchives(): void {
  for (const id of [...openArchives.keys()]) closeOpenedArchive(id);
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
};

/**
 * CSP for archived pages. Scripts are allowed because many archived pages
 * need their own JS to display captured content -- but the session-level
 * network block means those scripts have nowhere to send anything, and
 * connect-src 'none' stops fetch/XHR/WebSocket at the page level too.
 */
const ARCHIVE_CSP = [
  `default-src ${ARCHIVE_SITE_SCHEME}: 'unsafe-inline' 'unsafe-eval' data: blob:`,
  `img-src ${ARCHIVE_SITE_SCHEME}: data: blob:`,
  `style-src ${ARCHIVE_SITE_SCHEME}: 'unsafe-inline' data:`,
  `font-src ${ARCHIVE_SITE_SCHEME}: data:`,
  `script-src ${ARCHIVE_SITE_SCHEME}: 'unsafe-inline' 'unsafe-eval'`,
  `media-src ${ARCHIVE_SITE_SCHEME}: data: blob:`,
  `frame-src ${ARCHIVE_SITE_SCHEME}:`,
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function getSiteArchiveSession(): Session {
  if (sessionInstance) return sessionInstance;

  const sess = session.fromPartition(SITEARCHIVE_PARTITION, { cache: false });

  // Hard network block: only our own scheme (and devtools) survive. This
  // is the guarantee that "archived viewing never touches the internet",
  // enforced at the session layer rather than by trusting page content.
  sess.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith(`${ARCHIVE_SITE_SCHEME}://`) || details.url.startsWith('devtools://')) {
      callback({ cancel: false });
      return;
    }
    if (details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url.startsWith('about:')) {
      callback({ cancel: false });
      return;
    }
    logger.warn('sitearchive_session.network_blocked', { url: redactForLog(details.url) });
    callback({ cancel: true });
  });

  sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  sess.setPermissionCheckHandler(() => false);

  registerArchiveSiteProtocol(sess);
  sessionInstance = sess;
  return sess;
}

export function registerArchiveSiteProtocol(sess: Session): void {
  sess.protocol.handle(ARCHIVE_SITE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const archiveId = url.hostname;
      const archive = openArchives.get(archiveId);
      if (!archive) {
        return textResponse('This archive is no longer open.', 404);
      }

      const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

      // Explicit "not captured" page for links that were never archived.
      if (rawPath === '__unavailable__') {
        const target = url.searchParams.get('url') ?? '';
        return htmlResponse(unavailablePageHtml(target, archive.manifest.siteTitle), 200);
      }

      // archive-site://<id>/page/<pageId>
      if (rawPath.startsWith('page/')) {
        const pageId = rawPath.slice('page/'.length);
        const page = archive.getPage(pageId);
        if (!page) return htmlResponse(unavailablePageHtml('', archive.manifest.siteTitle), 404);
        const html = await archive.readEntry(page.htmlPath, page.htmlSha256);
        // Link rewriting happens here, not at capture time: the route map
        // is only complete once the whole crawl has finished, so a link
        // captured on page 1 to a page discovered later still resolves.
        const routed = rewriteLinks(html.toString('utf8'), archive, archiveId, page.finalUrl);
        return new Response(injectArchiveRuntime(routed, archiveId), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': ARCHIVE_CSP,
          },
        });
      }

      // archive-site://<id>/screenshot/<pageId>
      if (rawPath.startsWith('screenshot/')) {
        const pageId = rawPath.slice('screenshot/'.length);
        const page = archive.getPage(pageId);
        if (!page?.screenshotPath) return textResponse('No screenshot for this page', 404);
        const buf = await archive.readEntry(page.screenshotPath, page.screenshotSha256);
        return binaryResponse(buf, 'image/png');
      }

      // archive-site://<id>/text/<pageId>
      if (rawPath.startsWith('text/')) {
        const pageId = rawPath.slice('text/'.length);
        const page = archive.getPage(pageId);
        if (!page?.textPath) return textResponse('No extracted text for this page', 404);
        const buf = await archive.readEntry(page.textPath, page.textSha256);
        return new Response(buf, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // Direct entry paths: assets/<sha>.<ext>, responses/<sha>.json
      if (rawPath.startsWith('assets/')) {
        const sha = rawPath.slice('assets/'.length).split('.')[0] ?? '';
        const asset = archive.getAsset(sha);
        if (!asset) return textResponse('Asset not found in archive', 404);
        const buf = await archive.readEntry(asset.path, asset.sha256);
        return binaryResponse(buf, asset.contentType);
      }

      if (rawPath.startsWith('responses/')) {
        const sha = rawPath.slice('responses/'.length).split('.')[0] ?? '';
        const resp = archive.getResponse(sha);
        if (!resp) return textResponse('Response not found in archive', 404);
        const buf = await archive.readEntry(resp.path, resp.sha256);
        return binaryResponse(buf, resp.contentType);
      }

      return textResponse('Not found in archive', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('sitearchive_protocol.error', { error: message });
      return textResponse(`Archive error: ${message}`, 500);
    }
  });
}

function binaryResponse(buf: Buffer, contentType: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ARCHIVE_CSP,
    },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ARCHIVE_CSP,
    },
  });
}

export function contentTypeForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Rewrite every <a href> so it resolves inside the archive.
 *
 * Resolution order for each link:
 *   1. Normalize it against the page's own URL (so relative links,
 *      query strings, and redirect sources all resolve correctly).
 *   2. If the route map has a page for it -> archive-site://<id>/page/<pageId>,
 *      preserving any #fragment so anchors still work.
 *   3. If it maps to an archived asset (a captured PDF, image, etc.)
 *      -> the local archived copy.
 *   4. Otherwise leave the original href in data-archive-original-href
 *      and point the link at the "not captured" page. The injected
 *      runtime never lets an un-rewritten http(s) link reach the network.
 */
function rewriteLinks(html: string, archive: OpenedArchive, archiveId: string, pageUrl: string): string {
  const base = `${ARCHIVE_SITE_SCHEME}://${archiveId}`;
  return html.replace(/<a\b([^>]*?)href="([^"]*)"([^>]*)>/gi, (full, before: string, href: string, after: string) => {
    if (!href || href.startsWith('#')) return full; // in-page anchor
    if (href.startsWith(`${ARCHIVE_SITE_SCHEME}://`)) return full; // already routed

    const lower = href.toLowerCase();
    // Non-http schemes (mailto:, tel:, custom handlers) are left for the
    // runtime to intercept and route through explicit confirmation.
    if (!/^https?:/i.test(lower) && !href.startsWith('/') && !href.startsWith('.') && lower.includes(':')) {
      return `<a${before}href="${escapeAttr(href)}" data-archive-original-href="${escapeAttr(href)}"${after}>`;
    }

    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch {
      return full;
    }

    const fragment = (() => {
      const i = absolute.indexOf('#');
      return i >= 0 ? absolute.slice(i) : '';
    })();

    const normalized = normalizeUrl(absolute);
    const route = normalized ? archive.lookupRoute(normalized) : null;

    if (route?.target.type === 'page') {
      return `<a${before}href="${base}/page/${route.target.pageId}${fragment}" data-archive-original-href="${escapeAttr(absolute)}"${after}>`;
    }
    if (route?.target.type === 'asset') {
      const asset = archive.getAsset(route.target.sha256);
      if (asset) {
        return `<a${before}href="${base}/${asset.path}" data-archive-original-href="${escapeAttr(absolute)}"${after}>`;
      }
    }

    const unavailable = `${base}/__unavailable__?url=${encodeURIComponent(absolute)}`;
    return `<a${before}href="${unavailable}" data-archive-original-href="${escapeAttr(absolute)}"${after}>`;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Runtime injected into every archived page.
 *
 * It intercepts link clicks and form submissions so that navigation stays
 * inside the archive: an archived target opens the archived page, an
 * un-archived target shows the "not captured" page with an explicit
 * "Open Live Version" action, and external handlers (mailto:, tel:,
 * custom protocols, executables) are routed to the app for confirmation
 * rather than being followed silently. Back/forward/refresh keep working
 * because these remain real navigations within archive-site://.
 */
function injectArchiveRuntime(html: string, archiveId: string): string {
  const runtime = `
<script data-archive-runtime="true">
(function () {
  var ARCHIVE_ID = ${JSON.stringify(archiveId)};
  var SCHEME = ${JSON.stringify(ARCHIVE_SITE_SCHEME)};

  function isArchiveUrl(u) { return u && u.indexOf(SCHEME + '://') === 0; }

  function originalUrlOf(el) {
    return el.getAttribute('data-archive-original-href') || el.getAttribute('href') || '';
  }

  function unavailableUrl(original) {
    return SCHEME + '://' + ARCHIVE_ID + '/__unavailable__?url=' + encodeURIComponent(original || '');
  }

  document.addEventListener('click', function (event) {
    var a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return; // in-page anchors work natively

    // Already rewritten to point inside the archive -- let it navigate.
    if (isArchiveUrl(href)) return;

    event.preventDefault();

    var lower = href.toLowerCase();
    var isExternalHandler =
      lower.indexOf('mailto:') === 0 || lower.indexOf('tel:') === 0 ||
      (lower.indexOf('http:') !== 0 && lower.indexOf('https:') !== 0 && lower.indexOf('/') !== 0 && lower.indexOf('.') !== 0);

    if (isExternalHandler) {
      // Requires explicit confirmation in the app; never opened silently.
      window.location.href = unavailableUrl(href) + '&handler=external';
      return;
    }

    // http(s) link that was not captured.
    var absolute = href;
    try { absolute = new URL(href, ${JSON.stringify('about:blank')}).href; } catch (e) {}
    window.location.href = unavailableUrl(a.getAttribute('data-archive-original-href') || href);
  }, true);

  // Archived forms are read-only: never submit, never reach the network.
  document.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
    var banner = document.createElement('div');
    banner.textContent = 'This form is part of an offline archive and cannot be submitted.';
    banner.setAttribute('style', 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;background:#222;color:#fff;padding:10px 16px;border-radius:6px;font:13px sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4)');
    document.body.appendChild(banner);
    setTimeout(function () { banner.remove(); }, 3500);
  }, true);

  // Service workers must never run in archived mode.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('Service workers are disabled in offline archives'));
      };
    }
  } catch (e) {}

  // Neutralize network APIs so archived scripts fail fast and visibly
  // rather than hanging on a blocked request.
  try {
    window.fetch = function () { return Promise.reject(new Error('Network access is disabled in this offline archive')); };
    var XHR = window.XMLHttpRequest;
    if (XHR) {
      window.XMLHttpRequest = function () {
        var x = new XHR();
        x.open = function () { throw new Error('Network access is disabled in this offline archive'); };
        return x;
      };
    }
    window.WebSocket = function () { throw new Error('Network access is disabled in this offline archive'); };
  } catch (e) {}
})();
</script>`;

  if (html.includes('</body>')) return html.replace('</body>', `${runtime}</body>`);
  return html + runtime;
}

function unavailablePageHtml(originalUrl: string, siteTitle: string): string {
  const safeUrl = escapeHtml(originalUrl);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Not in this archive</title>
<style>
  body { font: 14px/1.6 -apple-system, "Segoe UI", sans-serif; background:#1e1e1e; color:#e8e8e8; margin:0; padding:48px 32px; }
  .card { max-width:640px; margin:0 auto; background:#2a2a2a; border:1px solid #444; border-radius:10px; padding:28px; }
  h1 { font-size:18px; margin:0 0 12px; }
  code { background:#1a1a1a; padding:3px 6px; border-radius:4px; word-break:break-all; font-size:12px; }
  p { color:#bbb; }
  button { background:#4a90e2; color:#fff; border:none; border-radius:6px; padding:9px 16px; font-size:13px; cursor:pointer; margin-top:14px; }
  .note { font-size:12px; color:#8a8a8a; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>This page wasn't captured in this archive</h1>
    <p>The archive of <strong>${escapeHtml(siteTitle)}</strong> does not include:</p>
    <p><code>${safeUrl || '(unknown address)'}</code></p>
    <p>It may have been outside the capture scope, blocked, or failed during capture.</p>
    <button id="openLive">Open Live Version</button>
    <div class="note">Opening the live version leaves the offline archive and uses your internet connection. Nothing on this page has contacted the network.</div>
  </div>
  <script>
    document.getElementById('openLive').addEventListener('click', function () {
      // Signalled to the app via the title; the main process watches for
      // this and asks the user to confirm before opening anything.
      document.title = 'ARCHIVE_OPEN_LIVE:' + ${JSON.stringify(originalUrl)};
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function redactForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[unparsable]';
  }
}

export { normalizeUrl };
