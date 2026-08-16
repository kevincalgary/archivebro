import { session, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerArchiveProtocolHandler } from './offlineProtocol';
import { logger } from '../util/logger';

const OFFLINE_PARTITION = 'offline-viewer';
let offlineSession: Session | null = null;

/**
 * A session dedicated to rendering archived pages, with every request
 * except our own `archive://` scheme blocked at the webRequest layer. This
 * is enforced independently of "JavaScript is disabled by default" --
 * even a future mode that re-enables scripting for a specific archive
 * still cannot make this session emit real network traffic.
 */
export function getOfflineSession(getArchivesRoot: () => string): Session {
  if (offlineSession) return offlineSession;

  offlineSession = session.fromPartition(OFFLINE_PARTITION, { cache: false });
  registerArchiveProtocolHandler(offlineSession, getArchivesRoot);

  offlineSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('archive://') || details.url.startsWith('devtools://')) {
      callback({ cancel: false });
      return;
    }
    // Chromium's MHTML document loader only recognizes a document as MHTML
    // when it's loaded via file: (see tabManager.ts openOfflineTab for the
    // full explanation) -- allow it, but ONLY for a path that resolves
    // inside the archives root, independently re-checked here even though
    // the caller already validated it before calling loadFile(). No other
    // file: path, and nothing else network-shaped, gets through.
    if (details.url.startsWith('file://')) {
      const root = pathToFileURL(path.resolve(getArchivesRoot())).toString();
      if (details.url === root || details.url.startsWith(root + '/')) {
        callback({ cancel: false });
        return;
      }
    }
    logger.warn('offline_session.network_blocked', {});
    callback({ cancel: true });
  });

  offlineSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  offlineSession.setPermissionCheckHandler(() => false);

  return offlineSession;
}
