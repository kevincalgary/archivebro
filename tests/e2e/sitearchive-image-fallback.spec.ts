import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, dismissCaptureDialog } from './sitearchive-helpers';
import { openSiteArchive, type OpenedArchive } from '../../src/main/sitearchive/archiveReader';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-img-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

async function activeTabId(): Promise<string> {
  const tabs = await siteHooks(handle.app).listTabs();
  const id = tabs[0]?.id;
  if (!id) throw new Error('No tab');
  return id;
}

/** Capture /images (the page full of awkward image cases) and open it. */
async function captureImagesPage(): Promise<{ archive: OpenedArchive; html: string; archivePath: string }> {
  let archivePath = '';
  await withSiteFixture(async (site) => {
    await navigateViaAddressBar(handle, `${site.url}/images`);
    await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/images'));
    // Give the inline scripts (canvas painting, blob URL creation) time to run.
    await handle.window.waitForTimeout(600);

    archivePath = path.join(outDir, 'Images.sitearchive');
    const hooks = siteHooks(handle.app);
    await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), archivePath);
    const result = await hooks.awaitCapture();
    expect(result).toBeTruthy();
  });
  await dismissCaptureDialog(handle);

  const archive = await openSiteArchive(archivePath);
  const page = archive.manifest.pages[0]!;
  const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
  return { archive, html, archivePath };
}

test.describe('image screenshot fallback', () => {
  test('normal images are downloaded normally, not screenshotted', async () => {
    const { archive, html } = await captureImagesPage();
    try {
      // The red/blue PNGs and the SVG are reachable, so they must be
      // stored as their original bytes -- downloading is always preferred
      // because it preserves the real file.
      const realImages = archive.manifest.assets.filter((a) => a.kind === 'image' && !a.screenshotFallback);
      expect(realImages.length).toBeGreaterThan(0);

      // Those normal images are referenced through the archive scheme.
      expect(html).toContain('archive-site://');
      expect(html).toContain('data-archive-original-src');
    } finally {
      archive.close();
    }
  });

  test('a canvas is preserved as its rendered pixels', async () => {
    const { archive, html } = await captureImagesPage();
    try {
      // The fixture paints the canvas red with a white square. A readable
      // canvas is serialized directly to a data: URL <img>.
      // A readable canvas is serialized directly to its pixels, which is
      // preferred over screenshotting the element.
      const hasCanvasImage = html.includes('data-archive-from="canvas"');
      const hasCanvasScreenshot = archive.manifest.assets.some(
        (a) => a.screenshotFallback?.elementType === 'canvas',
      );
      expect(hasCanvasImage || hasCanvasScreenshot).toBe(true);
      expect(hasCanvasImage).toBe(true);
      // The original <canvas> element must not survive as an empty canvas.
      expect(html).not.toMatch(/<canvas[^>]*id="canvas"/);
    } finally {
      archive.close();
    }
  });

  test('a blob-URL image is preserved via the screenshot fallback', async () => {
    const { archive, html } = await captureImagesPage();
    try {
      // A blob: URL cannot be re-fetched, so the only way to preserve it
      // is to screenshot the rendered element. This must actually produce
      // a screenshot asset -- not silently degrade to a placeholder.
      const blobFallback = archive.manifest.assets.find((a) =>
        a.screenshotFallback?.originalUrl?.startsWith('blob:'),
      );
      expect(blobFallback).toBeTruthy();
      expect(blobFallback!.contentType).toBe('image/png');
      expect(blobFallback!.byteSize).toBeGreaterThan(100);

      // The rendered dimensions match the element as displayed (80x80),
      // and the screenshot is captured at the device pixel ratio.
      const meta = blobFallback!.screenshotFallback!;
      expect(meta.renderedWidth).toBe(80);
      expect(meta.renderedHeight).toBe(80);
      expect(meta.screenshotWidth).toBeGreaterThanOrEqual(80);

      // The archived page references the screenshot in the image's place
      // and marks it as a rendered screenshot rather than the original.
      expect(html).toContain('data-archive-rendered-screenshot="true"');

      // The stored bytes are a real, decodable PNG.
      const bytes = await archive.readEntry(blobFallback!.path, blobFallback!.sha256);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      archive.close();
    }
  });

  test('screenshot fallbacks are only used after normal download fails', async () => {
    const { archive } = await captureImagesPage();
    try {
      // Every reachable image (red.png, blue.png, logo.svg) is stored as
      // its original bytes; only the un-fetchable blob: image required a
      // screenshot. Downloading stays the preferred path.
      const originals = archive.manifest.assets.filter((a) => !a.screenshotFallback && a.kind === 'image');
      const fallbacks = archive.manifest.assets.filter((a) => a.screenshotFallback);

      expect(originals.length).toBeGreaterThanOrEqual(3);
      expect(fallbacks).toHaveLength(1);
      // The original PNGs keep their true source URL and original bytes.
      expect(originals.some((a) => a.sourceUrls.some((u) => u.endsWith('/img/red.png')))).toBe(true);
      expect(originals.some((a) => a.sourceUrls.some((u) => u.endsWith('/img/blue.png')))).toBe(true);
    } finally {
      archive.close();
    }
  });

  test('capturing leaves no bookkeeping attributes behind on the live page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/images`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/images'));
      await handle.window.waitForTimeout(600);

      const hooks = siteHooks(handle.app);
      const out = path.join(outDir, 'Clean.sitearchive');
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      // The pairing/marker attributes are internal bookkeeping and must be
      // removed from the user's actual page after capture.
      const leftover = await hooks.evalInActiveTab(
        'document.querySelectorAll("[data-archive-uid],[data-archive-needs-screenshot]").length',
      );
      expect(Number(leftover)).toBe(0);
    });
  });

  test('screenshot-derived assets carry full provenance metadata', async () => {
    const { archive } = await captureImagesPage();
    try {
      const fallbacks = archive.manifest.assets.filter((a) => a.screenshotFallback);
      for (const asset of fallbacks) {
        const meta = asset.screenshotFallback!;
        // Every field the spec requires must be present and sane.
        expect(meta.isRenderedScreenshot).toBe(true);
        expect(meta.pageUrl).toContain('/images');
        expect(typeof meta.elementType).toBe('string');
        expect(meta.renderedWidth).toBeGreaterThan(0);
        expect(meta.renderedHeight).toBeGreaterThan(0);
        expect(meta.screenshotWidth).toBeGreaterThan(0);
        expect(meta.screenshotHeight).toBeGreaterThan(0);
        expect(new Date(meta.capturedAt).toString()).not.toBe('Invalid Date');
        expect(meta.reason.length).toBeGreaterThan(0);
        // Content hash and the screenshot flag distinguish it from an original.
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.contentType).toBe('image/png');
      }
    } finally {
      archive.close();
    }
  });

  test('a broken image is never screenshotted as a browser placeholder icon', async () => {
    const { archive, html } = await captureImagesPage();
    try {
      // #broken points at a 404. Its rendered box is the browser's broken
      // -image icon, which validation must reject -- so it becomes an
      // explicit "unavailable" placeholder, not a screenshot asset.
      const brokenAsScreenshot = archive.manifest.assets.some(
        (a) => a.screenshotFallback?.originalUrl?.includes('does-not-exist'),
      );
      expect(brokenAsScreenshot).toBe(false);
      expect(html).toContain('Image unavailable in this archive');
    } finally {
      archive.close();
    }
  });

  test('a 1x1 tracking pixel is never screenshotted', async () => {
    const { archive } = await captureImagesPage();
    try {
      // Validation rejects <=3px elements outright.
      const tiny = archive.manifest.assets.filter(
        (a) => a.screenshotFallback && a.screenshotFallback.renderedWidth <= 3 && a.screenshotFallback.renderedHeight <= 3,
      );
      expect(tiny).toEqual([]);
    } finally {
      archive.close();
    }
  });

  test('a link wrapping an image is preserved when the image is replaced', async () => {
    const { archive, html } = await captureImagesPage();
    try {
      // #linked sits inside <a href="/about">. Whatever happens to the
      // image, the surrounding hyperlink must survive.
      expect(html).toContain('id="wrapping-link"');
      const linkIndex = html.indexOf('id="wrapping-link"');
      const afterLink = html.slice(linkIndex, linkIndex + 400);
      expect(afterLink).toMatch(/<img|image-unavailable/);
    } finally {
      archive.close();
    }
  });

  test('screenshot assets are deduplicated by content hash like any other asset', async () => {
    const { archive } = await captureImagesPage();
    try {
      const hashes = archive.manifest.assets.map((a) => a.sha256);
      expect(new Set(hashes).size).toBe(hashes.length);
    } finally {
      archive.close();
    }
  });

  test('capturing restores the page scroll position afterwards', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/lazy`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/lazy'));

      const hooks = siteHooks(handle.app);
      // Scroll somewhere specific first, and confirm it took effect.
      await hooks.evalInActiveTab('window.scrollTo(0, 420); "ok"');
      await handle.window.waitForTimeout(200);
      const before = await hooks.evalInActiveTab('Math.round(window.scrollY)');
      expect(Number(before)).toBeGreaterThan(300);

      const out = path.join(outDir, 'Scroll.sitearchive');
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      // The lazy-load sweep scrolls the whole page; the user's position
      // must be exactly where they left it when capture finishes.
      const after = await hooks.evalInActiveTab('Math.round(window.scrollY)');
      expect(Math.abs(Number(after) - Number(before))).toBeLessThanOrEqual(2);
    });
  });

  test('the fallback never captures private content sitting outside the image box', async () => {
    const { archive } = await captureImagesPage();
    try {
      // The fixture page renders SECRET-ACCOUNT-NUMBER-12345 next to the
      // images. Screenshot crops are the element's own rect, so no
      // fallback asset may be large enough to have swept it in: assert
      // each crop matches the element it came from.
      for (const asset of archive.manifest.assets.filter((a) => a.screenshotFallback)) {
        const meta = asset.screenshotFallback!;
        const ratio = meta.screenshotWidth / Math.max(1, meta.renderedWidth);
        // The crop is the element box scaled by device pixel ratio only.
        expect(ratio).toBeLessThanOrEqual(4);
        expect(meta.screenshotHeight / Math.max(1, meta.renderedHeight)).toBeLessThanOrEqual(4);
        // And it is never the size of the whole page.
        expect(meta.renderedWidth).toBeLessThan(1000);
      }
    } finally {
      archive.close();
    }
  });

  test('archived pages using a screenshot fallback still render offline', async () => {
    const { archive, archivePath } = await captureImagesPage();
    archive.close();

    const hooks = siteHooks(handle.app);
    await hooks.openSiteArchivePath(archivePath);

    const tabs = await waitForTabs(
      handle.app,
      (t) => t.some((x) => x.isSiteArchive && x.url.startsWith('archive-site://') && !x.isLoading),
      15_000,
    );
    const archiveTab = tabs.find((t) => t.isSiteArchive)!;
    expect(archiveTab.title).toContain('Image Variations');
  });
});
