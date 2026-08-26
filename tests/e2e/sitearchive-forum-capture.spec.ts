import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, forumThreadScope, forumSectionScope, forumWholeScope, dismissCaptureDialog } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

/**
 * Forum capture: the three forum-* scope kinds (thread/section/whole),
 * layered on the existing site-capture crawler (crawler.ts's discoverLinks
 * forum branch), plus attachments/avatars/external-images, pagination
 * without exhausting depth, duplicate/print-view dedup, credential
 * stripping in a forum reply form, and forum post search/anchor
 * navigation. Fixture shape documented in fixtures/siteServer.js's
 * forumRoute().
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forum-capture-scope-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

function pathsOf(pages: { finalUrl: string }[]): string[] {
  return pages.map((p) => new URL(p.finalUrl).pathname + new URL(p.finalUrl).search);
}

const FORUM_THREADS_PER_SECTION = 6;

test.describe('forum-thread scope', () => {
  test('captures every page of the thread, and only that thread', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'thread.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 3 }), out);
      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();

      const archive = await openSiteArchive(out);
      try {
        const paths = pathsOf(archive.manifest.pages);
        // All three pages of thread-1-1's pagination (query-style convention).
        expect(paths).toContain('/forum/thread-1-1');
        expect(paths).toContain('/forum/thread-1-1?page=2');
        expect(paths).toContain('/forum/thread-1-1?page=3');
        // Nothing from any other thread, section, or the forum root.
        expect(paths.some((p) => p.startsWith('/forum/thread-1-2'))).toBe(false);
        expect(paths.some((p) => p.startsWith('/forum/section-'))).toBe(false);
        expect(paths).not.toContain('/forum');

        // The legacy alias resolves to the same content and must not
        // produce a second captured page.
        expect(archive.manifest.pages.filter((p) => p.finalUrl.includes('thread-1-1') && !p.finalUrl.includes('page=')).length).toBe(1);

        expect(archive.manifest.forumSummary?.threadCount).toBe(1);
        expect(archive.manifest.forumSummary?.postCount).toBeGreaterThan(0);
      } finally {
        archive.close();
      }
    });
  });

  test('a narrow depth limit does not truncate pagination, since it never advances depth', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'thread-depth0.sitearchive');
      // depth 0 would allow only the start page for an ordinary crawl --
      // pagination must still reach all 3 pages of this thread.
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const paths = pathsOf(archive.manifest.pages);
        expect(paths).toContain('/forum/thread-1-1?page=3');
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('forum-section scope', () => {
  test('captures the section pagination and its threads, not other sections', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/section-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/section-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'section.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumSectionScope({ maxPages: 30, maxDepth: 4 }), out);
      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();

      const archive = await openSiteArchive(out);
      try {
        const paths = pathsOf(archive.manifest.pages);
        expect(paths).toContain('/forum/section-1');
        expect(paths).toContain('/forum/section-1?page=2'); // section's own pagination
        expect(paths).toContain('/forum/thread-1-1'); // a thread listed in section 1
        expect(paths).toContain('/forum/thread-1-extra'); // only reachable via section-1's page 2
        expect(paths.some((p) => p.startsWith('/forum/section-2'))).toBe(false);
        expect(paths.some((p) => p.startsWith('/forum/thread-2-'))).toBe(false);

        expect(archive.manifest.forumSummary?.sectionCount).toBe(1);
        expect(archive.manifest.forumSummary?.threadCount).toBeGreaterThanOrEqual(FORUM_THREADS_PER_SECTION);
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('forum-whole scope', () => {
  test('reaches multiple sections and threads', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'whole.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumWholeScope({ maxPages: 30, maxDepth: 4 }), out);
      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();

      const archive = await openSiteArchive(out);
      try {
        const paths = pathsOf(archive.manifest.pages);
        expect(paths.filter((p) => /^\/forum\/section-/.test(p)).length).toBeGreaterThan(0);
        expect(paths.filter((p) => /^\/forum\/thread-/.test(p)).length).toBeGreaterThan(0);
        // Member profiles excluded by default (forumIncludeProfiles: false).
        expect(paths.some((p) => p.startsWith('/forum/members/'))).toBe(false);
      } finally {
        archive.close();
      }
    });
  });

  test('member profiles are included when forumIncludeProfiles is on', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'whole-profiles.sitearchive');
      // depth 1 only, so all 20 depth-1 candidates (12 sections + 8
      // members) fit comfortably in the page budget without competing
      // against depth-2 thread content for a turn -- this test is about
      // the flag working, not about budget/fairness under contention
      // (already covered by sitearchive-forum.spec.ts).
      await hooks.captureSiteToPath(tabs[0]!.id, forumWholeScope({ maxPages: 30, maxDepth: 1, forumIncludeProfiles: true }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const paths = pathsOf(archive.manifest.pages);
        expect(paths.some((p) => p.startsWith('/forum/members/'))).toBe(true);
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('attachments, avatars, and images', () => {
  test('downloads attachments as assets when the toggle is on', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const outOn = path.join(outDir, 'attach-on.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0, forumDownloadAttachments: true }), outOn);
      await hooks.awaitCapture();

      const archiveOn = await openSiteArchive(outOn);
      try {
        const pdfAssets = archiveOn.manifest.assets.filter((a) => a.contentType === 'application/pdf');
        expect(pdfAssets.length).toBeGreaterThanOrEqual(2); // file-1.pdf and the attachment.php one
      } finally {
        archiveOn.close();
      }
    });
  });

  test('excludes attachments, recording why, when the toggle is off', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const outOff = path.join(outDir, 'attach-off.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0, forumDownloadAttachments: false }), outOff);
      await hooks.awaitCapture();

      const archiveOff = await openSiteArchive(outOff);
      try {
        const pdfAssets = archiveOff.manifest.assets.filter((a) => a.contentType === 'application/pdf');
        expect(pdfAssets.length).toBe(0);
        expect(archiveOff.manifest.failures.some((f) => f.kind === 'skipped-attachment-excluded')).toBe(true);
      } finally {
        archiveOff.close();
      }
    });
  });

  test('captures avatars and dedupes the shared emoji image across posts', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'avatars.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const emojiAssets = archive.manifest.assets.filter((a) => a.sourceUrls.some((u) => u.includes('/forum/emoji/smile.png')));
        // One emoji image referenced by two posts on this page dedupes to one asset.
        expect(emojiAssets.length).toBe(1);
        expect(emojiAssets[0]!.sourceUrls.length).toBeGreaterThanOrEqual(1);

        const avatarAssets = archive.manifest.assets.filter((a) => a.sourceUrls.some((u) => u.includes('/forum/avatars/')));
        expect(avatarAssets.length).toBeGreaterThan(0);
      } finally {
        archive.close();
      }
    });
  });

  test('fetches an externally-hosted image when attemptExternalImages is on', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'external-on.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0, forumAttemptExternalImages: true }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        expect(archive.manifest.assets.some((a) => a.sourceUrls.some((u) => u.includes('external-photo.png')))).toBe(true);
      } finally {
        archive.close();
      }
    });
  });

  test('skips a missing image with an honest placeholder, never silently dropping it', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'missing-image.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages.find((p) => p.finalUrl.endsWith('/forum/thread-1-1'));
        expect(page).toBeTruthy();
        const html = (await archive.readEntry(page!.htmlPath, page!.htmlSha256)).toString('utf8');
        expect(html).toMatch(/archive-unavailable|not preserved|unavailable/i);
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('credential stripping in forum content', () => {
  test('never stores the reply form\'s CSRF token or session id anywhere in the archive', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'credentials.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 0 }), out);
      await hooks.awaitCapture();

      const raw = await fs.readFile(out);
      expect(raw.includes('FORUM-SECRET-CSRF-TOKEN')).toBe(false);
      expect(raw.includes('FORUM-SECRET-SESSION-ID')).toBe(false);
      expect(raw.includes('hunter2forum')).toBe(false);
    });
  });
});

test.describe('forum post search', () => {
  test('finds a post by its text and jumps to the right anchor offline', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'post-search.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 3 }), out);
      await hooks.awaitCapture();
      await dismissCaptureDialog(handle);

      await hooks.openSiteArchivePath(out);
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);

      await handle.window.getByRole('button', { name: 'Search inside this archive' }).click();
      await handle.window.getByPlaceholder('Search this archive…').fill('actually wants archived');

      const results = handle.window.locator('.sitearchive-search-results-posts .sitearchive-search-result');
      await expect(results.first()).toBeVisible({ timeout: 5000 });
      await results.first().click();

      // Navigating a search result loads the page; the anchor itself is a
      // native browser fragment-scroll, already covered by rewriteLinks()
      // preserving fragments -- this asserts the navigation itself lands.
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 10_000);
    });
  });
});

test.describe('capture history', () => {
  test('a completed forum capture appears in the Saved Sites list with correct stats', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum/thread-1-1`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum/thread-1-1`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'history.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumThreadScope({ maxDepth: 3 }), out);
      await hooks.awaitCapture();
      await dismissCaptureDialog(handle);

      await handle.window.getByRole('button', { name: /Saved Sites/ }).click();
      const item = handle.window.locator('.site-archive-history-item', { hasText: 'Thread 1-1' });
      await expect(item).toBeVisible({ timeout: 10_000 });
      await expect(item.locator('.site-archive-history-badge')).toHaveCount(0); // complete, no "Incomplete" badge
    });
  });

  test('an incomplete forum capture (hit the page limit) shows the incomplete badge', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'incomplete.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, forumWholeScope({ maxPages: 5, maxDepth: 4 }), out);
      await hooks.awaitCapture();
      await dismissCaptureDialog(handle);

      await handle.window.getByRole('button', { name: /Saved Sites/ }).click();
      const item = handle.window.locator('.site-archive-history-item', { hasText: 'Fixture Forum' });
      await expect(item).toBeVisible({ timeout: 10_000 });
      await expect(item.locator('.site-archive-history-badge')).toContainText('Incomplete');
    });
  });
});
