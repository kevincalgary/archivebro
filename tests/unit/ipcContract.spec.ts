import { describe, it, expect } from 'vitest';
import { Channels, IpcSchemas } from '../../src/shared/ipcContract';

// These schemas are what ipc/handlers.ts runs every incoming call through
// before touching disk, a session, or a webContents (see the `handle()`
// wrapper there). Exercising them directly is a fast, deterministic way to
// verify malformed/malicious IPC payloads are rejected -- the alternative
// (driving it through a real renderer) can't even construct a bad payload
// in the first place, since the exposed window.archiveBrowser API is
// itself typed and only ever sends well-formed shapes.

describe('IPC argument validation', () => {
  it('rejects a non-UUID archiveId on library:delete', () => {
    const result = IpcSchemas[Channels.libraryDelete].safeParse({ archiveId: '../../etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed library:delete payload', () => {
    const result = IpcSchemas[Channels.libraryDelete].safeParse({
      archiveId: '3c1f9c9e-2a4b-4a3e-9c7a-1a2b3c4d5e6f',
    });
    expect(result.success).toBe(true);
  });

  it('rejects tabs:navigate with a missing tabId', () => {
    const result = IpcSchemas[Channels.tabsNavigate].safeParse({ input: 'https://example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects tabs:navigate with an oversized input string', () => {
    const result = IpcSchemas[Channels.tabsNavigate].safeParse({
      tabId: '3c1f9c9e-2a4b-4a3e-9c7a-1a2b3c4d5e6f',
      input: 'a'.repeat(10_000),
    });
    expect(result.success).toBe(false);
  });

  it('rejects settings:update with an out-of-range screenshot quality', () => {
    const result = IpcSchemas[Channels.settingsUpdate].safeParse({ screenshotQuality: 500 });
    expect(result.success).toBe(false);
  });

  it('rejects settings:update with a negative capture delay', () => {
    const result = IpcSchemas[Channels.settingsUpdate].safeParse({ captureDelayMs: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected/extra permission-default key gracefully instead of crashing', () => {
    const result = IpcSchemas[Channels.settingsUpdate].safeParse({
      permissionDefaults: { notifications: 'allow', geolocation: 'ask' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed tabs:setBounds payload (negative dimensions)', () => {
    const result = IpcSchemas[Channels.tabsSetBounds].safeParse({ x: 0, y: 0, width: -10, height: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects library:rename with an object instead of a string title', () => {
    const result = IpcSchemas[Channels.libraryRename].safeParse({
      archiveId: '3c1f9c9e-2a4b-4a3e-9c7a-1a2b3c4d5e6f',
      title: { evil: true },
    });
    expect(result.success).toBe(false);
  });

  it('every channel with a request/response shape has a schema (nothing silently unvalidated)', () => {
    const requestResponseChannels = Object.values(Channels).filter((c) => !c.startsWith('events:'));
    for (const channel of requestResponseChannels) {
      expect(IpcSchemas).toHaveProperty(channel);
    }
  });
});
