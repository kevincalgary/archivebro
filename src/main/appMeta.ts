import { app } from 'electron';

export const SCHEMA_VERSION = 2;

export function getAppVersion(): string {
  return app.getVersion();
}

// Most call sites want a plain constant; app.getVersion() is safe to call
// at any point after the `electron` module is loaded (it reads package.json
// directly), so this is resolved once at module init.
export const APP_VERSION = app.getVersion();
