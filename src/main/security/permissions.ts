import type { Session } from 'electron';
import type { PermissionKind } from '../../shared/types';
import type { SettingsStore } from '../settings/settingsStore';
import { logger } from '../util/logger';

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
 * Deny-by-default permission handling for browsing sessions. Anything not
 * in KNOWN_PERMISSIONS (e.g. window-management, hid, usb, serial,
 * midiSysex) is denied outright -- we don't attempt to support device
 * access at all. Known kinds fall back to the user's configured default
 * ('ask' | 'deny' | 'allow'); 'ask' is not wired to a UI prompt in this
 * MVP and currently resolves to deny (see README known limitations) rather
 * than silently allowing.
 */
export function installPermissionHandlers(session: Session, settings: SettingsStore): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      logger.info('permission.denied_unknown', { permission });
      callback(false);
      return;
    }
    const defaults = settings.get().permissionDefaults;
    const decision = defaults[permission as PermissionKind] ?? 'deny';
    logger.info('permission.request', { permission, decision });
    callback(decision === 'allow');
  });

  session.setPermissionCheckHandler((_webContents, permission) => {
    if (!KNOWN_PERMISSIONS.has(permission)) return false;
    const defaults = settings.get().permissionDefaults;
    return (defaults[permission as PermissionKind] ?? 'deny') === 'allow';
  });

  // Certificate errors are never silently ignored/accepted.
  session.setCertificateVerifyProc((_request, callback) => {
    callback(-3); // use Chromium's own verification result
  });
}
