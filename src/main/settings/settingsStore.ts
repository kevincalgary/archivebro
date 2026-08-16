import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../../shared/types';
import { logger } from '../util/logger';

const SETTINGS_FILE = 'settings.json';

function defaultSettings(): AppSettings {
  return {
    autoCaptureEnabled: true,
    captureDelayMs: 3000,
    archiveStorageDir: path.join(app.getPath('userData'), 'archives'),
    maxDiskUsageMb: null,
    retentionDays: null,
    excludedDomains: [],
    searchEngineUrlTemplate: 'https://duckduckgo.com/?q=%s',
    screenshotQuality: 80,
    permissionDefaults: {
      notifications: 'deny',
      geolocation: 'ask',
      camera: 'deny',
      microphone: 'deny',
      midi: 'deny',
      'clipboard-read': 'ask',
      'display-capture': 'deny',
    },
  };
}

export class SettingsStore {
  private settings: AppSettings;
  private filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), SETTINGS_FILE);
    this.settings = this.load();
  }

  private load(): AppSettings {
    const defaults = defaultSettings();
    if (!existsSync(this.filePath)) return defaults;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return { ...defaults, ...raw, permissionDefaults: { ...defaults.permissionDefaults, ...raw.permissionDefaults } };
    } catch (err) {
      logger.error('settings.load_failed', { error: String(err) });
      return defaults;
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  get(): AppSettings {
    return { ...this.settings, excludedDomains: [...this.settings.excludedDomains] };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      permissionDefaults: { ...this.settings.permissionDefaults, ...patch.permissionDefaults },
    };
    this.persist();
    return this.get();
  }

  isDomainExcluded(domain: string): boolean {
    const d = domain.toLowerCase();
    return this.settings.excludedDomains.some((excluded) => {
      const e = excluded.toLowerCase().trim();
      if (!e) return false;
      return d === e || d.endsWith(`.${e}`);
    });
  }

  addExcludedDomain(domain: string): AppSettings {
    if (!this.settings.excludedDomains.includes(domain)) {
      this.settings.excludedDomains.push(domain);
      this.persist();
    }
    return this.get();
  }
}
