import { describe, it, expect } from 'vitest';
import { shouldAutoCheck } from '../../src/main/updates/updateService';

describe('shouldAutoCheck', () => {
  it('runs only when both enabled by settings AND packaged', () => {
    expect(shouldAutoCheck(true, true)).toBe(true);
  });

  it('never runs when the app is not packaged (dev, tests, e2e), regardless of the setting', () => {
    expect(shouldAutoCheck(true, false)).toBe(false);
    expect(shouldAutoCheck(false, false)).toBe(false);
  });

  it('never runs when the user has turned automatic checks off, even when packaged', () => {
    expect(shouldAutoCheck(false, true)).toBe(false);
  });
});
