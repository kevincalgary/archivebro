import { useEffect, useState } from 'react';
import type { AppSettings, DiskUsageInfo, PermissionKind, UpdateStatus } from '../../../shared/types';
import { LoadingPanel } from '../Progress';

const PERMISSION_KINDS: PermissionKind[] = [
  'notifications',
  'geolocation',
  'camera',
  'microphone',
  'midi',
  'clipboard-read',
  'display-capture',
];

function updateStatusText(status: UpdateStatus | null): string {
  if (!status) return '';
  switch (status.state) {
    case 'idle':
      return '';
    case 'unsupported-dev':
      return 'Not available in this build (unpackaged/development).';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available':
      return "You're up to date.";
    case 'downloading':
      return status.version
        ? `Downloading version ${status.version}${status.progressPercent != null ? ` (${status.progressPercent}%)` : ''}…`
        : 'Downloading update…';
    case 'downloaded':
      return `Version ${status.version} is ready to install.`;
    case 'error':
      return `Update check failed: ${status.error ?? 'unknown error'}`;
    default:
      return '';
  }
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [diskUsage, setDiskUsage] = useState<DiskUsageInfo | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  const refresh = () => {
    void window.archiveBrowser.settings.get().then(setSettings);
    void window.archiveBrowser.settings.getDiskUsage().then(setDiskUsage);
    void window.archiveBrowser.updates.getStatus().then(setUpdateStatus);
  };

  useEffect(refresh, []);

  useEffect(() => window.archiveBrowser.events.onUpdateStatus(setUpdateStatus), []);

  if (!settings) {
    return (
      <div className="settings-screen">
        <LoadingPanel message="Loading settings…" />
      </div>
    );
  }

  async function update(patch: Partial<AppSettings>) {
    const next = await window.archiveBrowser.settings.update(patch);
    setSettings(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  }

  return (
    <div className="settings-screen">
      <h1>Settings {savedFlash && <span className="settings-saved">Saved</span>}</h1>

      <section>
        <h2>Automatic capture</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoCaptureEnabled}
            onChange={(e) => update({ autoCaptureEnabled: e.target.checked })}
          />
          Automatically archive pages I visit
        </label>
        <label className="field-row">
          Capture delay (ms after page settles)
          <input
            type="number"
            min={0}
            max={60000}
            value={settings.captureDelayMs}
            onChange={(e) => update({ captureDelayMs: Number(e.target.value) })}
          />
        </label>
        <label className="field-row">
          Screenshot quality
          <input
            type="range"
            min={1}
            max={100}
            value={settings.screenshotQuality}
            onChange={(e) => update({ screenshotQuality: Number(e.target.value) })}
          />
          {settings.screenshotQuality}
        </label>
      </section>

      <section>
        <h2>Storage</h2>
        <div className="field-row">
          <span>Archive location</span>
          <code className="storage-path">{settings.archiveStorageDir}</code>
          <button
            onClick={async () => {
              const next = await window.archiveBrowser.settings.pickStorageDir();
              if (next) setSettings(next);
              refresh();
            }}
          >
            Change…
          </button>
        </div>
        {diskUsage && (
          <p className="disk-usage-summary">
            {diskUsage.archiveCount} archives, {(diskUsage.totalBytes / (1024 * 1024)).toFixed(1)} MB used
            {diskUsage.quotaBytes ? ` of ${(diskUsage.quotaBytes / (1024 * 1024)).toFixed(0)} MB limit` : ''}
          </p>
        )}
        <label className="field-row">
          Max disk usage (MB, blank = unlimited)
          <input
            type="number"
            min={0}
            value={settings.maxDiskUsageMb ?? ''}
            placeholder="Unlimited"
            onChange={(e) => update({ maxDiskUsageMb: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label className="field-row">
          Retention (days, blank = keep forever)
          <input
            type="number"
            min={0}
            value={settings.retentionDays ?? ''}
            placeholder="Forever"
            onChange={(e) => update({ retentionDays: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <p className="settings-note">
          Archives are never deleted automatically unless one of the limits above is set.
        </p>
      </section>

      <section>
        <h2>Excluded domains</h2>
        <p className="settings-note">Pages on these domains are never automatically archived.</p>
        <div className="field-row">
          <input
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newDomain.trim()) {
                update({ excludedDomains: [...settings.excludedDomains, newDomain.trim().toLowerCase()] });
                setNewDomain('');
              }
            }}
          />
          <button
            onClick={() => {
              if (!newDomain.trim()) return;
              update({ excludedDomains: [...settings.excludedDomains, newDomain.trim().toLowerCase()] });
              setNewDomain('');
            }}
          >
            Add
          </button>
        </div>
        <ul className="excluded-domain-list">
          {settings.excludedDomains.map((d) => (
            <li key={d}>
              {d}
              <button onClick={() => update({ excludedDomains: settings.excludedDomains.filter((x) => x !== d) })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Search engine</h2>
        <label className="field-row">
          URL template (%s = query)
          <input
            value={settings.searchEngineUrlTemplate}
            onChange={(e) => update({ searchEngineUrlTemplate: e.target.value })}
          />
        </label>
      </section>

      <section>
        <h2>Permission defaults</h2>
        <p className="settings-note">Applies to sites you browse. Nothing is ever allowed unless set to Allow here.</p>
        {PERMISSION_KINDS.map((kind) => (
          <label key={kind} className="field-row">
            {kind}
            <select
              value={settings.permissionDefaults[kind]}
              onChange={(e) =>
                update({
                  permissionDefaults: { ...settings.permissionDefaults, [kind]: e.target.value as 'ask' | 'deny' | 'allow' },
                })
              }
            >
              <option value="deny">Deny</option>
              <option value="ask">Ask (currently denies until prompt UI ships)</option>
              <option value="allow">Allow</option>
            </select>
          </label>
        ))}
      </section>

      <section>
        <h2>Updates</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoUpdateCheckEnabled}
            onChange={(e) => update({ autoUpdateCheckEnabled: e.target.checked })}
          />
          Automatically check for updates
        </label>
        <p className="settings-note">
          On by default. This is the one network request Archive Browser makes on its own, unprompted by anything you
          do — a periodic check against GitHub Releases for a newer version. Turning it off does not disable the
          manual check below, since clicking it is its own explicit action.
        </p>
        <div className="field-row">
          <button
            disabled={updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'}
            onClick={async () => setUpdateStatus(await window.archiveBrowser.updates.checkNow())}
          >
            Check for updates now
          </button>
          {updateStatus?.state === 'downloaded' && (
            <button onClick={() => window.archiveBrowser.updates.installNow()}>Restart and install</button>
          )}
        </div>
        {updateStatusText(updateStatus) && <p className="settings-note">{updateStatusText(updateStatus)}</p>}
      </section>

      <section>
        <h2>Diagnostics</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.diagnosticLogging}
            onChange={(e) => update({ diagnosticLogging: e.target.checked })}
          />
          Record full URLs in the log file
        </label>
        <p className="settings-note">
          Off by default: logs normally record only a site's origin (for example{' '}
          <code>https://example.com</code>), never the full address of a page you visited, and never page content or
          credentials. Turn this on only while reproducing a bug — the log file on disk will then contain the addresses
          of pages you visit.
        </p>
      </section>

      <section>
        <h2>Data</h2>
        <div className="danger-zone">
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Clear browsing data (cookies, cache, site storage) for normal tabs?')) return;
              await window.archiveBrowser.settings.clearBrowsingData();
            }}
          >
            Clear browsing data
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Delete ALL archived pages? This cannot be undone.')) return;
              await window.archiveBrowser.settings.clearArchiveData();
              refresh();
            }}
          >
            Clear all archive data
          </button>
        </div>
        <div className="field-row">
          <button onClick={() => window.archiveBrowser.settings.export()}>Export settings…</button>
          <button
            onClick={async () => {
              await window.archiveBrowser.settings.import();
              refresh();
            }}
          >
            Import settings…
          </button>
        </div>
      </section>
    </div>
  );
}
