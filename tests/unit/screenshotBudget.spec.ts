import { describe, it, expect } from 'vitest';
import { fitCaptureToBudget } from '../../src/main/capture/screenshotCapture';

/**
 * The capture budget is expressed in CSS pixels but Chromium rasterizes at
 * the display's device pixel ratio, so every limit has to survive being
 * multiplied by dpr (and the area limit, by dpr^2).
 *
 * These are the limits the implementation must not exceed. Chromium's real
 * texture ceiling is 16384 in one dimension; going over it fails the whole
 * capture, which is what silently downgraded 693 of 810 pages to viewport
 * crops on a real crawl.
 */
const CHROMIUM_MAX_TEXTURE_DIM = 16_384;
const MAX_DEVICE_PIXELS = 32_000_000;

describe('fitCaptureToBudget', () => {
  it('keeps a tall page on a 2x display inside the texture limit', () => {
    // The exact shape that used to fail: a full-height page on Retina.
    // Old behaviour clamped to 12000 CSS px and asked for 24000 device px.
    const fit = fitCaptureToBudget({ cssWidth: 1265, cssHeight: 40_000, deviceScaleFactor: 2 });

    expect(fit.deviceHeight).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
    expect(fit.deviceWidth).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
    expect(fit.deviceWidth * fit.deviceHeight).toBeLessThanOrEqual(MAX_DEVICE_PIXELS);
  });

  it('does not scale down a page that already fits', () => {
    const fit = fitCaptureToBudget({ cssWidth: 1265, cssHeight: 2000, deviceScaleFactor: 1 });

    expect(fit.scale).toBe(1);
    expect(fit.width).toBe(1265);
    expect(fit.height).toBe(2000);
    expect(fit.deviceWidth).toBe(1265);
    expect(fit.deviceHeight).toBe(2000);
  });

  it('accounts for the device ratio rather than the CSS size alone', () => {
    // Same page, three ratios. The CSS-pixel geometry is identical, so a
    // budget that ignored dpr would return identical results for all three.
    const at1 = fitCaptureToBudget({ cssWidth: 1265, cssHeight: 9000, deviceScaleFactor: 1 });
    const at2 = fitCaptureToBudget({ cssWidth: 1265, cssHeight: 9000, deviceScaleFactor: 2 });
    const at3 = fitCaptureToBudget({ cssWidth: 1265, cssHeight: 9000, deviceScaleFactor: 3 });

    expect(at1.scale).toBeGreaterThan(at2.scale);
    expect(at2.scale).toBeGreaterThan(at3.scale);

    for (const fit of [at1, at2, at3]) {
      expect(fit.deviceHeight).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
      expect(fit.deviceWidth * fit.deviceHeight).toBeLessThanOrEqual(MAX_DEVICE_PIXELS);
    }
  });

  it('clamps width to the content limit', () => {
    const fit = fitCaptureToBudget({ cssWidth: 6000, cssHeight: 800, deviceScaleFactor: 1 });
    expect(fit.width).toBe(2400);
  });

  it('never returns a degenerate region', () => {
    const fit = fitCaptureToBudget({ cssWidth: 0, cssHeight: 0, deviceScaleFactor: 2 });
    expect(fit.width).toBeGreaterThanOrEqual(1);
    expect(fit.height).toBeGreaterThanOrEqual(1);
    expect(fit.scale).toBeGreaterThan(0);
  });

  it('holds every limit across the full range of real page shapes', () => {
    // A crawl meets pages of every shape on displays of every ratio; the
    // invariants have to hold for all of them, not just the cases above.
    const widths = [320, 800, 1265, 1280, 2400, 5000];
    const heights = [100, 900, 4000, 8131, 12_000, 20_000, 40_000];
    const ratios = [1, 1.5, 2, 2.5, 3];

    for (const cssWidth of widths) {
      for (const cssHeight of heights) {
        for (const deviceScaleFactor of ratios) {
          const fit = fitCaptureToBudget({ cssWidth, cssHeight, deviceScaleFactor });
          const where = `${cssWidth}x${cssHeight} @${deviceScaleFactor}x`;

          expect(fit.deviceWidth, `width ${where}`).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
          expect(fit.deviceHeight, `height ${where}`).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
          expect(fit.deviceWidth * fit.deviceHeight, `area ${where}`).toBeLessThanOrEqual(MAX_DEVICE_PIXELS);
          expect(fit.scale, `scale ${where}`).toBeGreaterThan(0);
          expect(fit.scale, `scale ${where}`).toBeLessThanOrEqual(1);
          expect(fit.height, `height>0 ${where}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('still produces a legible shot for the worst page shape in range', () => {
    // The largest region the CSS clamps permit, on the highest ratio we
    // rasterize at. It has to fit without scaling into uselessness --
    // otherwise the screenshot stops being a usable fallback.
    const fit = fitCaptureToBudget({ cssWidth: 40_000, cssHeight: 40_000, deviceScaleFactor: 3 });

    expect(fit.scale).toBeGreaterThan(0.25);
    expect(fit.deviceHeight).toBeLessThanOrEqual(CHROMIUM_MAX_TEXTURE_DIM);
    expect(fit.deviceWidth * fit.deviceHeight).toBeLessThanOrEqual(MAX_DEVICE_PIXELS);
  });
});
