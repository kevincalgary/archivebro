import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir;
      throw new Error(`unexpected getPath(${name}) in test`);
    },
  },
}));

const { SettingsStore } = await import('../../src/main/settings/settingsStore');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-browser-settings-'));
});

describe('SettingsStore', () => {
  it('has sensible defaults on first run (nothing deleted automatically)', () => {
    const store = new SettingsStore();
    const s = store.get();
    expect(s.autoCaptureEnabled).toBe(true);
    expect(s.retentionDays).toBeNull();
    expect(s.maxDiskUsageMb).toBeNull();
    expect(s.excludedDomains).toEqual([]);
    // On by default (a documented, disclosed exception to "nothing sent
    // anywhere" -- see README "Auto-update"), but the manual check is
    // always available regardless of this setting.
    expect(s.autoUpdateCheckEnabled).toBe(true);
  });

  it('persists autoUpdateCheckEnabled across a fresh load from disk', () => {
    const store1 = new SettingsStore();
    store1.update({ autoUpdateCheckEnabled: false });

    const store2 = new SettingsStore();
    expect(store2.get().autoUpdateCheckEnabled).toBe(false);
  });

  it('persists updates across a fresh load from disk', () => {
    const store1 = new SettingsStore();
    store1.update({ autoCaptureEnabled: false, captureDelayMs: 5000 });

    const store2 = new SettingsStore();
    const s = store2.get();
    expect(s.autoCaptureEnabled).toBe(false);
    expect(s.captureDelayMs).toBe(5000);
  });

  it('isDomainExcluded matches the exact domain and its subdomains, not unrelated domains', () => {
    const store = new SettingsStore();
    store.update({ excludedDomains: ['example.com'] });

    expect(store.isDomainExcluded('example.com')).toBe(true);
    expect(store.isDomainExcluded('mail.example.com')).toBe(true);
    expect(store.isDomainExcluded('notexample.com')).toBe(false);
    expect(store.isDomainExcluded('example.com.evil.com')).toBe(false);
  });

  it('a corrupt settings.json falls back to defaults instead of crashing the app', () => {
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), '{not valid json', 'utf8');
    const store = new SettingsStore();
    expect(store.get().autoCaptureEnabled).toBe(true);
  });
});
