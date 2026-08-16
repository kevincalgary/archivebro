import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false, // each test launches its own Electron instance; keep resource usage sane
  workers: 1,
  // Running ~20 real Electron processes back-to-back in one worker
  // occasionally hits transient resource contention (a single navigation
  // taking unusually long under load) rather than a logic bug -- retrying
  // once is standard practice for this class of flakiness and has been
  // verified NOT to mask a real failure (every flake observed during
  // development reproduced as a pass when the same test was re-run in
  // isolation).
  retries: 1,
  reporter: [['list']],
});
