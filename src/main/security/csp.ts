import type { Session } from 'electron';

// Strict CSP for the trusted chrome window only. No remote script, no
// inline script/style beyond what React's dev/prod build needs (Vite
// injects a small module-preload snippet; we allow 'unsafe-inline' for
// style only because React inlines a handful of layout styles -- script is
// never relaxed). Nothing about this CSP applies to browsing or offline
// WebContentsViews; they get their own, separate policies.
const TRUSTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: archive:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

export function applyTrustedCsp(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [TRUSTED_CSP],
      },
    });
  });
}

// Offline archive viewer: JS disabled by default at the webPreferences
// level (see offlineSession.ts), but we still ship a belt-and-suspenders
// CSP in case a future mode re-enables scripting for a specific archive.
export const OFFLINE_CSP = [
  "default-src 'none'",
  "img-src archive: data:",
  "style-src archive: 'unsafe-inline'",
  "font-src archive: data:",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');
