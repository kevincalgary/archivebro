import type { Session } from 'electron';
import type { PermissionKind } from '../../shared/types';
import type { SettingsStore } from '../settings/settingsStore';
import { logger } from '../util/logger';
import { requestPermissionFromUser } from './permissionPrompts';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<PermissionKind>([
  'notifications',
  'geolocation',
  'camera',
  'microphone',
  'midi',
  'clipboard-read',
  'display-capture',
]);

/**
 * Deny-by-default permission handling for browsing sessions.
 *
 * Anything not in KNOWN_PERMISSIONS (e.g. window-management, hid, usb,
 * serial, midiSysex) is denied outright -- we don't attempt to support
 * device access at all. Known kinds follow the user's configured default:
 *   'deny'  -> refused immediately
 *   'allow' -> granted immediately
 *   'ask'   -> the user is prompted, and is denied if they don't answer.
 *
 * Nothing is ever granted without either a standing 'allow' setting or an
 * explicit answer -- there is no path where silence means yes.
 */
export function installPermissionHandlers(session: Session, settings: SettingsStore): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      logger.info('permission.denied_unknown', { permission });
      callback(false);
      return;
    }

    const kind = permission as PermissionKind;
    const decision = settings.get().permissionDefaults[kind] ?? 'deny';
    logger.info('permission.request', { permission, decision });

    if (decision === 'allow') {
      callback(true);
      return;
    }
    if (decision === 'deny') {
      callback(false);
      return;
    }

    // 'ask': prompt the user. Only the origin is passed to the UI, never
    // the full URL, so a prompt can't leak a sensitive path.
    let origin = '';
    try {
      origin = new URL(webContents.getURL()).origin;
    } catch {
      origin = 'this site';
    }
    void requestPermissionFromUser(kind, origin, webContents.id).then((allow) => callback(allow));
  });

  session.setPermissionCheckHandler((_webContents, permission) => {
    if (!KNOWN_PERMISSIONS.has(permission)) return false;
    const defaults = settings.get().permissionDefaults;
    // A synchronous check cannot prompt, so anything not already granted
    // standing permission reports false.
    return (defaults[permission as PermissionKind] ?? 'deny') === 'allow';
  });

  // Certificate errors are never silently ignored/accepted.
  session.setCertificateVerifyProc((_request, callback) => {
    callback(-3); // use Chromium's own verification result
  });
}
