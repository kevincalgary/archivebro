import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { loadUrl } from '../../src/main/sitearchive/crawler';

/**
 * `loadUrl` only touches a handful of WebContents methods (on,
 * removeListener, loadURL, stop) and never Electron internals directly, so
 * a plain EventEmitter stands in for it here without needing a real
 * multi-process Electron app -- unlike most of this crawler, which is only
 * exercised through e2e (see the module docstring on why: navigation
 * timeout and redirect-loop handling live here and retryFailedPages.ts
 * reuses this exact function).
 */
function fakeWebContents() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    loadURL: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  });
}

describe('loadUrl', () => {
  it('resolves ok on did-finish-load', async () => {
    const wc = fakeWebContents();
    const promise = loadUrl(wc as never, 'https://example.com/');
    wc.emit('did-finish-load');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('reports a render-process-gone kill distinctly rather than waiting out the load timeout', async () => {
    // The gap this closes: before render-process-gone was handled, a
    // renderer killed mid-navigation (crash, or Chromium's own OOM kill)
    // fired none of the other listeners, so the promise sat until
    // PAGE_LOAD_TIMEOUT_MS and got recorded as a generic 'timeout' --
    // exactly the blind spot that left the 151-minute landrover.ca crash's
    // cause unidentified (see Known Limitations / memoryTelemetry.ts).
    const wc = fakeWebContents();
    const promise = loadUrl(wc as never, 'https://example.com/');
    wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
    const result = await promise;
    expect(result).toEqual({
      ok: false,
      kind: 'render-process-gone',
      message: 'Renderer process gone: oom (exit code -1)',
    });
  });

  it('ignores further events once settled', async () => {
    const wc = fakeWebContents();
    const promise = loadUrl(wc as never, 'https://example.com/');
    wc.emit('did-finish-load');
    wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
    await expect(promise).resolves.toEqual({ ok: true });
  });
});
