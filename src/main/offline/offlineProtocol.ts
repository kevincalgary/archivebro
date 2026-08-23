import { protocol, type Session } from 'electron';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { archiveDirFor, isValidArchiveId } from '../util/paths';
import { logger } from '../util/logger';
import { OFFLINE_CSP } from '../security/csp';
import { sha256Hex } from '../util/hash';
import type { ArchiveRepo } from '../db/archiveRepo';

/**
 * Looks up the capture-time SHA-256 recorded for one hashed file of an
 * archive, or null if there's nothing to verify against (either the
 * archive doesn't exist, or it predates the integrity-hash column and
 * genuinely never recorded one).
 */
export type ExpectedHashLookup = (archiveId: string, file: 'screenshot' | 'text') => string | null;

/** Files served through this protocol whose bytes are checksum-verified before being returned. */
const HASHED_FILES: Record<string, 'screenshot' | 'text'> = {
  'screenshot.png': 'screenshot',
  'text.txt': 'text',
};

/** The `ExpectedHashLookup` backed by the real catalog. */
export function expectedHashLookup(archiveRepo: ArchiveRepo): ExpectedHashLookup {
  return (archiveId, file) => {
    const detail = archiveRepo.getById(archiveId);
    if (!detail) return null;
    return file === 'screenshot' ? detail.screenshotSha256 : detail.textSha256;
  };
}

/**
 * The MHTML snapshot is loaded via `loadFile()`, not through this protocol
 * (see tabManager.ts openOfflineTab), so it can't be verified inline the
 * way screenshot/text are above -- this is checked once, up front, right
 * before that load. Returns false ("treat as if there's no MHTML") on a
 * hash mismatch, which routes the viewer down the same well-tested
 * fallback path a failed capture already uses, rather than ever handing
 * tampered bytes to `loadFile()`. `expectedSha256` null (predates the hash
 * column) skips verification, same convention as everywhere else here.
 */
export async function verifyMhtmlIntegrity(
  hasMhtml: boolean,
  mhtmlPath: string,
  expectedSha256: string | null,
  archiveId: string,
): Promise<boolean> {
  if (!hasMhtml || !expectedSha256) return hasMhtml;
  try {
    const data = await fs.readFile(mhtmlPath);
    if (sha256Hex(data) === expectedSha256) return true;
    logger.error('offline_tab.mhtml_checksum_mismatch', { archiveId });
    return false;
  } catch (err) {
    logger.error('offline_tab.mhtml_read_failed', {
      archiveId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const ARCHIVE_SCHEME = 'archive';

/** Must run before `app.whenReady()`. */
export function registerArchiveSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARCHIVE_SCHEME,
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

const CONTENT_TYPES: Record<string, string> = {
  '.mhtml': 'multipart/related',
  '.mht': 'multipart/related',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Serve `archive://<archive-id>/<file>` for a given archives root. Every
 * request is resolved through archiveDirFor(), which rejects anything that
 * isn't a bare UUID host or that would resolve outside the archives root --
 * a page rendered through this protocol (or a compromised offline
 * WebContentsView) cannot use `../` or an absolute path to read arbitrary
 * files, because the id is validated before any path is ever built. This
 * is registered per-session (offline viewer, and the trusted window's
 * default session for Library thumbnails) rather than exposing raw
 * `file://` access to either.
 */
export function registerArchiveProtocolHandler(
  sess: Session,
  getArchivesRoot: () => string,
  getExpectedHash: ExpectedHashLookup,
): void {
  sess.protocol.handle(ARCHIVE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const archiveId = url.hostname;
      if (!isValidArchiveId(archiveId)) {
        return new Response('Invalid archive id', { status: 400 });
      }
      const dir = archiveDirFor(getArchivesRoot(), archiveId);
      const requestedFile = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

      if (requestedFile === '__fallback__') {
        return await buildFallbackResponse(dir, url.searchParams.get('reason'));
      }

      if (!requestedFile || requestedFile.includes('..') || path.isAbsolute(requestedFile)) {
        return new Response('Invalid path', { status: 400 });
      }
      const filePath = path.join(dir, requestedFile);
      if (!filePath.startsWith(dir + path.sep) || !existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

      // Read directly via Node's fs rather than net.fetch(file://...) --
      // Electron's net.fetch refuses the file: scheme by design (it's meant
      // for real network requests), so this is the correct way for a main-
      // process protocol handler to serve local file contents. (MHTML
      // itself is never requested through this handler -- see
      // tabManager.ts openOfflineTab for why it's loaded via file:// instead.)
      const data = await fs.readFile(filePath);

      const hashedKind = HASHED_FILES[requestedFile];
      if (hashedKind) {
        const expected = getExpectedHash(archiveId, hashedKind);
        // null means either the archive predates the hash column or wasn't
        // found -- nothing recorded, nothing to verify, same convention
        // the .sitearchive reader uses for an unhashed manifest entry.
        if (expected && sha256Hex(data) !== expected) {
          logger.error('archive_protocol.checksum_mismatch', { archiveId, file: requestedFile });
          return new Response('Checksum mismatch -- this file may have been modified since it was captured', {
            status: 500,
          });
        }
      }

      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': OFFLINE_CSP,
        },
      });
    } catch (err) {
      logger.error('archive_protocol.error', { error: err instanceof Error ? err.message : String(err) });
      return new Response('Internal error', { status: 500 });
    }
  });
}

/**
 * A static, JS-free HTML page embedding the screenshot and extracted text
 * for archives whose MHTML is missing or fails to render. This is served
 * through the same archive:// scheme (rather than a data: URL) so it's
 * covered by the same CSP and stays consistent with "no raw file://
 * access" even for the fallback path.
 */
async function buildFallbackResponse(dir: string, reason: string | null): Promise<Response> {
  const screenshotPath = path.join(dir, 'screenshot.png');
  const textPath = path.join(dir, 'text.txt');
  const hasScreenshot = existsSync(screenshotPath);
  let text = '';
  try {
    text = await fs.readFile(textPath, 'utf8');
  } catch {
    text = '';
  }
  const bannerText =
    reason === 'integrity'
      ? 'This archived page failed an integrity check and could not be shown -- its saved MHTML snapshot does not match the hash recorded at capture time, which usually means the file was modified or corrupted after it was captured. Showing the saved screenshot and extracted text instead.'
      : 'This archived page could not be rendered faithfully. Showing the saved screenshot and extracted text instead.';

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #e8e8e8; }
  .banner { background: #3a2f00; border: 1px solid #6b5600; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; }
  img { max-width: 100%; border: 1px solid #444; border-radius: 4px; display: block; margin-bottom: 20px; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.5; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #9a9a9a; }
</style>
</head>
<body>
  <div class="banner">${escapeHtml(bannerText)}</div>
  ${hasScreenshot ? '<h2>Screenshot</h2><img src="screenshot.png" alt="Archived page screenshot">' : ''}
  <h2>Extracted text</h2>
  <pre>${escapeHtml(text) || '(no text was extracted for this archive)'}</pre>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': OFFLINE_CSP,
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
