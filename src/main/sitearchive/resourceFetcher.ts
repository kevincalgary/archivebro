import { net, type Session } from 'electron';
import { logger } from '../util/logger';

/**
 * Fetches subresources for a capture using the *live browsing session*,
 * so resources behind the user's existing login render correctly.
 *
 * Critically, only the response BODY is ever kept. Request/response
 * headers -- including Cookie, Set-Cookie, and Authorization -- are never
 * written into the archive, so a shared .sitearchive can never carry
 * reusable credentials.
 */

export interface FetchedResource {
  url: string;
  finalUrl: string;
  contentType: string;
  body: Buffer;
  status: number;
}

export interface FetchOptions {
  session: Session;
  maxBytes: number;
  timeoutMs: number;
}

/** Response content types that must never be stored -- credential material. */
const CREDENTIAL_CONTENT_TYPES = [
  'application/x-pkcs12',
  'application/x-pem-file',
  'application/pkcs8',
  'application/x-x509-ca-cert',
  'application/jwt',
];

/** URL patterns that signal credential/secret endpoints; skipped entirely. */
const SENSITIVE_URL_RE =
  /(\/oauth\/|\/token\b|\/session\b|\/login\b|\/signin\b|\/auth\b|\/credential|\/secret|\/apikey|\/api[-_]key|\.pem$|\.key$|\.p12$|\.pfx$|\/logout\b)/i;

export function isSensitiveResourceUrl(url: string): boolean {
  return SENSITIVE_URL_RE.test(url);
}

export function isCredentialContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return CREDENTIAL_CONTENT_TYPES.includes(base);
}

export async function fetchResource(url: string, options: FetchOptions): Promise<FetchedResource | null> {
  if (isSensitiveResourceUrl(url)) {
    logger.info('sitearchive.skipped_sensitive_url', {});
    return null;
  }

  return new Promise<FetchedResource | null>((resolve) => {
    let settled = false;
    const done = (value: FetchedResource | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      done(null);
    }, options.timeoutMs);

    // GET only. The capture pipeline never issues POST/PUT/PATCH/DELETE.
    const request = net.request({
      url,
      method: 'GET',
      session: options.session,
      useSessionCookies: true,
      redirect: 'follow',
    });

    request.on('response', (response) => {
      const status = response.statusCode;
      const headers = response.headers;
      const rawType = headers['content-type'];
      const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) ?? 'application/octet-stream';

      if (status >= 400) {
        response.on('data', () => {});
        response.on('end', () => done(null));
        response.on('error', () => done(null));
        return;
      }

      if (isCredentialContentType(contentType)) {
        logger.info('sitearchive.skipped_credential_content_type', {});
        response.on('data', () => {});
        response.on('end', () => done(null));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          try {
            request.abort();
          } catch {
            /* ignore */
          }
          done(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        done({
          url,
          finalUrl: url,
          contentType,
          body: Buffer.concat(chunks),
          status,
        });
      });
      response.on('error', () => done(null));
    });

    request.on('error', () => done(null));

    // Never send an Authorization header of our own; session cookies are
    // handled by Chromium for rendering, and neither is ever archived.
    try {
      request.end();
    } catch {
      done(null);
    }
  });
}
