import { describe, it, expect } from 'vitest';
import { findRendererMemory } from '../../src/main/capture/memoryTelemetry';
import type { ProcessMetric } from 'electron';

/**
 * Only the pure matching logic is unit-testable: `sampleCaptureMemory`
 * itself needs a real multi-process Electron app (a live webContents and
 * app.getAppMetrics()), so it's exercised implicitly by every e2e capture
 * test instead -- see recovery-ui.spec.ts and sitearchive-capture.spec.ts,
 * which all run real crawls with this telemetry wired in.
 */

function metric(pid: number, workingSetSizeKb: number, peakWorkingSetSizeKb = workingSetSizeKb): ProcessMetric {
  return {
    pid,
    type: 'Tab',
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    creationTime: Date.now(),
    memory: { workingSetSize: workingSetSizeKb, peakWorkingSetSize: peakWorkingSetSizeKb },
  };
}

describe('findRendererMemory', () => {
  it('converts the matched process\'s memory from KB to bytes', () => {
    const metrics = [metric(111, 1000), metric(222, 250_000, 300_000)];
    expect(findRendererMemory(metrics, 222)).toEqual({ bytes: 250_000 * 1024, peakBytes: 300_000 * 1024 });
  });

  it('returns null when no process matches the given pid', () => {
    const metrics = [metric(111, 1000)];
    expect(findRendererMemory(metrics, 999)).toBeNull();
  });

  it('returns null for an empty metrics list', () => {
    expect(findRendererMemory([], 123)).toBeNull();
  });

  it('does not confuse the browser/GPU process with the renderer being asked about', () => {
    // A real app.getAppMetrics() call returns every process -- the browser
    // process, GPU, utility processes, and every tab -- not just the one
    // this crawl cares about. Matching must be by pid, not by position.
    const metrics = [metric(1, 50_000), metric(2, 80_000), metric(3, 120_000)];
    expect(findRendererMemory(metrics, 3)).toEqual({ bytes: 120_000 * 1024, peakBytes: 120_000 * 1024 });
  });
});
