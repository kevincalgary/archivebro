import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchAppWithUserDataDir, testHooks } from './helpers';

test.describe('restart recovery', () => {
  test('a staging directory and bookkeeping row left by a simulated crash are cleaned up on next launch', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-browser-e2e-recovery-'));

    const first = await launchAppWithUserDataDir(userDataDir, false);
    const hooks1 = testHooks(first.app);
    const archivesRoot = await hooks1.archivesRoot();

    // Simulate a process that died mid-capture: markCaptureStarted() was
    // called (bookkeeping row written) and a staging directory was
    // created, but markCaptureFinished()/the final rename never happened
    // because the process died first. Runs through testHooks.ts (real
    // compiled code in the main process), matching how captureService.ts
    // itself would have done it.
    const fakeId = await hooks1.simulateCrashedCapture();
    expect(await hooks1.stagingDirExists(fakeId)).toBe(true);

    await first.app.close();

    // Second launch: recovery.ts (run at startup, before any tab is
    // created) should sweep the staging dir and clear the bookkeeping row.
    const second = await launchAppWithUserDataDir(userDataDir, true);
    try {
      const hooks2 = testHooks(second.app);
      await expect.poll(() => hooks2.stagingDirExists(fakeId)).toBe(false);
      await expect.poll(() => hooks2.isInterruptedCaptureTracked(fakeId)).toBe(false);

      const stagingDirOnDisk = path.join(archivesRoot, `.tmp-${fakeId}`);
      await expect(fs.stat(stagingDirOnDisk)).rejects.toThrow();
    } finally {
      await second.close();
    }
  });
});
