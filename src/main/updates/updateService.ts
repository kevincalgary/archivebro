import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { SettingsStore } from '../settings/settingsStore';
import { Channels } from '../../shared/ipcContract';
import { logger } from '../util/logger';
import type { UpdateStatus } from '../../shared/types';

// Give startup (tab restore, the interrupted-capture recovery prompt) a
// moment to settle before adding a network request of our own.
const INITIAL_CHECK_DELAY_MS = 30_000;
// Not so frequent that a long-running session hammers GitHub's API, not so
// rare that "on by default" feels hollow.
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function idleStatus(): UpdateStatus {
  return { state: 'idle', version: null, progressPercent: null, error: null, checkedAt: null };
}

/**
 * Whether an *unattended* (startup/periodic) check should run right now.
 * Pure and exported for testing. A manual "Check for updates now" click
 * always bypasses this -- see UpdateService.checkNow() -- since an explicit
 * action is its own consent regardless of the automatic-check setting.
 */
export function shouldAutoCheck(autoUpdateCheckEnabled: boolean, isPackaged: boolean): boolean {
  return autoUpdateCheckEnabled && isPackaged;
}

/**
 * Thin wrapper around electron-updater's autoUpdater: gates unattended
 * checks behind settings.autoUpdateCheckEnabled AND app.isPackaged (running
 * unpackaged -- dev, `npm test`, e2e -- must never make this network
 * request no matter what the setting says), tracks a status object the
 * renderer can both subscribe to and pull on demand, and never installs an
 * update without an explicit user click (installNow, wired to a "Restart to
 * update" button -- see SettingsScreen.tsx).
 */
export class UpdateService {
  private status: UpdateStatus = idleStatus();
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private mainWindow: BrowserWindow,
    private settings: SettingsStore,
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) =>
      this.setStatus({ state: 'downloading', version: info.version, progressPercent: 0 }),
    );
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'not-available', version: null }));
    autoUpdater.on('download-progress', (p) =>
      this.setStatus({ state: 'downloading', progressPercent: Math.round(p.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      this.setStatus({ state: 'downloaded', version: info.version, progressPercent: 100 }),
    );
    autoUpdater.on('error', (err) => {
      logger.error('updates.error', { error: err.message });
      this.setStatus({ state: 'error', error: err.message });
    });
  }

  /** Call once at startup, after the main window exists. */
  start(): void {
    if (!app.isPackaged) {
      // Never scheduled, ever -- not just skipped this once -- so a dev/
      // test/e2e run can never end up making this request on some timer.
      this.setStatus({ state: 'unsupported-dev' });
      return;
    }
    if (!shouldAutoCheck(this.settings.get().autoUpdateCheckEnabled, app.isPackaged)) return;

    this.initialTimer = setTimeout(() => void this.checkNow(), INITIAL_CHECK_DELAY_MS);
    this.interval = setInterval(() => {
      if (shouldAutoCheck(this.settings.get().autoUpdateCheckEnabled, app.isPackaged)) void this.checkNow();
    }, PERIODIC_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.interval) clearInterval(this.interval);
    this.initialTimer = null;
    this.interval = null;
  }

  /** Always allowed, regardless of settings.autoUpdateCheckEnabled -- see class doc. */
  async checkNow(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.setStatus({ state: 'unsupported-dev' });
      return this.status;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // The 'error' event above already handles most failures; this catches
      // a synchronous throw (e.g. a malformed feed config) that would
      // otherwise happen before that event ever fires.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('updates.check_failed', { error: message });
      this.setStatus({ state: 'error', error: message });
    }
    return this.status;
  }

  /** Only takes effect once a download has actually finished. */
  installNow(): void {
    if (this.status.state !== 'downloaded') return;
    autoUpdater.quitAndInstall();
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch, checkedAt: new Date().toISOString() };
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(Channels.onUpdateStatus, this.status);
    }
  }
}
