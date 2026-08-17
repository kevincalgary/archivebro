import { describe, it, expect } from 'vitest';
import { CaptureManager } from '../../src/main/sitearchive/captureManager';
import {
  DEFAULT_SITE_SCOPE,
  UNLIMITED_SITE_SCOPE,
  SCOPE_HARD_LIMITS,
  type CaptureScope,
} from '../../src/shared/sitearchiveTypes';
import { IpcSchemas, Channels } from '../../src/shared/ipcContract';

const base: CaptureScope = { ...DEFAULT_SITE_SCOPE };

describe('unlimited scope limits', () => {
  it('passes null limits straight through instead of re-imposing a cap', () => {
    const clamped = CaptureManager.clampScope({
      ...base,
      maxDepth: null,
      maxPages: null,
      maxTotalBytes: null,
    });
    expect(clamped.maxDepth).toBeNull();
    expect(clamped.maxPages).toBeNull();
    expect(clamped.maxTotalBytes).toBeNull();
  });

  it('still clamps finite values, so a typo cannot become a runaway crawl', () => {
    const clamped = CaptureManager.clampScope({
      ...base,
      maxDepth: 9999,
      maxPages: 9_999_999,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(clamped.maxDepth).toBe(SCOPE_HARD_LIMITS.maxDepth);
    expect(clamped.maxPages).toBe(SCOPE_HARD_LIMITS.maxPages);
    expect(clamped.maxTotalBytes).toBe(SCOPE_HARD_LIMITS.maxTotalBytes);
  });

  it('never lets concurrency be unbounded -- that protects the target server', () => {
    const clamped = CaptureManager.clampScope({ ...base, concurrency: 999 });
    expect(clamped.concurrency).toBe(SCOPE_HARD_LIMITS.maxConcurrency);
  });

  it('clamps negative or zero values to a usable minimum', () => {
    const clamped = CaptureManager.clampScope({ ...base, maxDepth: -5, maxPages: 0, maxTotalBytes: 1 });
    expect(clamped.maxDepth).toBe(0);
    expect(clamped.maxPages).toBe(1);
    expect(clamped.maxTotalBytes).toBe(1024 * 1024);
  });

  it('the UNLIMITED_SITE_SCOPE preset really has no bounds', () => {
    expect(UNLIMITED_SITE_SCOPE.maxDepth).toBeNull();
    expect(UNLIMITED_SITE_SCOPE.maxPages).toBeNull();
    expect(UNLIMITED_SITE_SCOPE.maxTotalBytes).toBeNull();
  });
});

describe('IPC validation accepts unlimited but still rejects nonsense', () => {
  const validate = (scope: unknown) =>
    IpcSchemas[Channels.siteCaptureStart].safeParse({
      tabId: '3c1f9c9e-2a4b-4a3e-9c7a-1a2b3c4d5e6f',
      scope,
    });

  it('accepts null limits over IPC', () => {
    expect(validate({ ...base, maxDepth: null, maxPages: null, maxTotalBytes: null }).success).toBe(true);
  });

  it('accepts ordinary finite limits', () => {
    expect(validate(base).success).toBe(true);
  });

  it('rejects a negative page limit', () => {
    expect(validate({ ...base, maxPages: -1 }).success).toBe(false);
  });

  it('rejects a non-numeric, non-null limit', () => {
    expect(validate({ ...base, maxPages: 'unlimited' }).success).toBe(false);
  });

  it('rejects concurrency above the hard cap', () => {
    expect(validate({ ...base, concurrency: 99 }).success).toBe(false);
  });
});
