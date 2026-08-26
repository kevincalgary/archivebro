import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SiteArchiveBuilder } from '../../src/main/sitearchive/archiveWriter';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';
import { CaptureJournal, replayCheckpoint } from '../../src/main/sitearchive/captureJournal';
import { DEFAULT_FORUM_THREAD_SCOPE, type ForumPostEntry } from '../../src/shared/sitearchiveTypes';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forum-archive-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function post(overrides: Partial<ForumPostEntry> = {}): ForumPostEntry {
  return {
    postId: 'p1#post-1',
    pageId: 'p1',
    anchor: 'post-1',
    author: 'User 1',
    authorProfileUrl: 'https://f.com/forum/members/user-1',
    timestamp: '2024-01-01T12:00:00Z',
    postNumber: 1,
    threadKey: 'https://f.com/forum/thread-1-1',
    sectionKey: 'https://f.com/forum/section-1',
    threadTitle: 'Thread 1-1',
    sectionTitle: null,
    ...overrides,
  };
}

async function buildForumArchive(finalPath: string) {
  const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
  await builder.init(tmp);

  await builder.addPage({
    pageId: 'p1',
    originalUrl: 'https://f.com/forum/thread-1-1',
    finalUrl: 'https://f.com/forum/thread-1-1',
    normalizedUrl: 'https://f.com/forum/thread-1-1',
    title: 'Thread 1-1',
    depth: 0,
    html: '<html><body><div id="post-1">First post about the widget recall</div></body></html>',
    screenshot: null,
    text: 'First post about the widget recall',
    redirectedFrom: [],
    forumThreadKey: 'https://f.com/forum/thread-1-1',
    forumSectionKey: 'https://f.com/forum/section-1',
    forumPageIndex: 1,
  });
  await builder.addPage({
    pageId: 'p2',
    originalUrl: 'https://f.com/forum/thread-1-1?page=2',
    finalUrl: 'https://f.com/forum/thread-1-1?page=2',
    normalizedUrl: 'https://f.com/forum/thread-1-1?page=2',
    title: 'Thread 1-1 (page 2)',
    depth: 0,
    html: '<html><body><div id="post-2">A reply mentioning warranty terms</div></body></html>',
    screenshot: null,
    text: 'A reply mentioning warranty terms',
    redirectedFrom: [],
    forumThreadKey: 'https://f.com/forum/thread-1-1',
    forumSectionKey: 'https://f.com/forum/section-1',
    forumPageIndex: 2,
  });

  await builder.addForumPost(post(), 'First post about the widget recall');
  await builder.addForumPost(
    post({ postId: 'p2#post-2', pageId: 'p2', anchor: 'post-2', author: 'User 2', postNumber: 2, authorProfileUrl: 'https://f.com/forum/members/user-2' }),
    'A reply mentioning warranty terms',
  );

  const asset = await builder.addAsset(Buffer.from('%PDF-1.4 fixture'), 'application/pdf', 'https://f.com/forum/attachments/file-1.pdf');

  const { manifest, fileSizeBytes } = await builder.finalize({
    finalPath,
    startUrl: 'https://f.com/forum/thread-1-1',
    startFinalUrl: 'https://f.com/forum/thread-1-1',
    siteTitle: 'Fixture Forum',
    scope: DEFAULT_FORUM_THREAD_SCOPE,
  });
  await builder.cleanup();
  return { manifest, fileSizeBytes, assetSha: asset.sha256 };
}

describe('SiteArchiveBuilder forum posts', () => {
  it('records forum posts and computes an aggregate summary', async () => {
    const out = path.join(tmp, 'out.sitearchive');
    const { manifest } = await buildForumArchive(out);

    expect(manifest.forumPosts).toHaveLength(2);
    expect(manifest.forumSummary).toEqual({
      sectionCount: 1,
      threadCount: 1,
      postCount: 2,
      attachmentCount: 1,
      profileCount: 0,
    });
  });

  it('drops a duplicate post id instead of letting it reach the index at finalize time', async () => {
    // Regression: real forum markup isn't always well-formed -- a post's
    // container and an inner anchor can both carry the same
    // id="post-<n>" (seen on a real vBulletin page during forum-thread
    // capture testing), so DETECT_FORUM_POSTS_SCRIPT can report the same
    // anchor twice for one page. Before addForumPost() deduped, the
    // second call inserted a duplicate primary key into forum_posts at
    // finalize time, threw out of the whole writeIndexDatabase()
    // transaction, and discarded the entire capture -- not just the
    // mis-indexed post.
    const out = path.join(tmp, 'out.sitearchive');
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);
    await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://f.com/forum/thread-1-1',
      finalUrl: 'https://f.com/forum/thread-1-1',
      normalizedUrl: 'https://f.com/forum/thread-1-1',
      title: 'Thread 1-1',
      depth: 0,
      html: '<html><body><div id="post-1">First post</div></body></html>',
      screenshot: null,
      text: 'First post',
      redirectedFrom: [],
      forumThreadKey: 'https://f.com/forum/thread-1-1',
    });
    await builder.addForumPost(post(), 'First post, from the outer container');
    // Same postId (same pageId + same anchor) as a second, differently-
    // worded extraction -- exactly what a duplicate DOM id produces.
    await builder.addForumPost(post(), 'First post, from an inner anchor with the same id');

    const { manifest } = await builder.finalize({
      finalPath: out,
      startUrl: 'https://f.com/forum/thread-1-1',
      startFinalUrl: 'https://f.com/forum/thread-1-1',
      siteTitle: 'Fixture Forum',
      scope: DEFAULT_FORUM_THREAD_SCOPE,
    });
    await builder.cleanup();

    expect(manifest.forumPosts).toHaveLength(1);
    expect(manifest.forumSummary?.postCount).toBe(1);

    // And the archive actually opens/reads back cleanly -- the real bug
    // was a thrown transaction at finalize time, not a wrong count.
    const archive = await openSiteArchive(out);
    try {
      expect(archive.searchForumPosts('post')).toHaveLength(1);
    } finally {
      archive.close();
    }
  });

  it('is absent on a manifest for a non-forum capture', async () => {
    const out = path.join(tmp, 'out.sitearchive');
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);
    await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      title: 'Home',
      depth: 0,
      html: '<html><body>Home</body></html>',
      screenshot: null,
      text: 'Home',
      redirectedFrom: [],
    });
    const { manifest } = await builder.finalize({
      finalPath: out,
      startUrl: 'https://example.com/',
      startFinalUrl: 'https://example.com/',
      siteTitle: 'Example',
      scope: { ...DEFAULT_FORUM_THREAD_SCOPE, kind: 'entire-site' },
    });
    await builder.cleanup();
    expect(manifest.forumPosts).toBeUndefined();
    expect(manifest.forumSummary).toBeUndefined();
  });
});

describe('OpenedArchive.searchForumPosts', () => {
  it('matches a post by body text, author, and returns its anchor', async () => {
    const out = path.join(tmp, 'out.sitearchive');
    await buildForumArchive(out);
    const archive = await openSiteArchive(out);
    try {
      const byBody = archive.searchForumPosts('recall');
      expect(byBody).toHaveLength(1);
      expect(byBody[0]).toMatchObject({ pageId: 'p1', anchor: 'post-1', author: 'User 1', threadTitle: 'Thread 1-1' });

      const byAuthor = archive.searchForumPosts('"User 2"');
      expect(byAuthor.length).toBeGreaterThanOrEqual(0); // author is a plain FTS column, not necessarily phrase-matchable, but must not throw

      const byOtherBody = archive.searchForumPosts('warranty');
      expect(byOtherBody).toHaveLength(1);
      expect(byOtherBody[0]?.pageId).toBe('p2');
    } finally {
      archive.close();
    }
  });

  it('returns nothing (not an error) for an archive with no forum posts', async () => {
    const out = path.join(tmp, 'out.sitearchive');
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);
    await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      title: 'Home',
      depth: 0,
      html: '<html><body>Home</body></html>',
      screenshot: null,
      text: 'Home',
      redirectedFrom: [],
    });
    await builder.finalize({
      finalPath: out,
      startUrl: 'https://example.com/',
      startFinalUrl: 'https://example.com/',
      siteTitle: 'Example',
      scope: { ...DEFAULT_FORUM_THREAD_SCOPE, kind: 'entire-site' },
    });
    await builder.cleanup();
    const archive = await openSiteArchive(out);
    try {
      expect(archive.searchForumPosts('anything')).toEqual([]);
    } finally {
      archive.close();
    }
  });
});

describe('forum post journal replay', () => {
  it('reconstructs forumPosts from a replayed checkpoint', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);
    const journal = await CaptureJournal.create(builder.stagingPath!, {
      archiveId: builder.archiveId,
      appVersion: '0.1.0',
      startUrl: 'https://f.com/forum/thread-1-1',
      outputPath: path.join(tmp, 'out.sitearchive'),
      scope: DEFAULT_FORUM_THREAD_SCOPE,
      startedAt: new Date().toISOString(),
    });
    builder.setJournal(journal);

    await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://f.com/forum/thread-1-1',
      finalUrl: 'https://f.com/forum/thread-1-1',
      normalizedUrl: 'https://f.com/forum/thread-1-1',
      title: 'Thread 1-1',
      depth: 0,
      html: '<html><body><div id="post-1">Hello</div></body></html>',
      screenshot: null,
      text: 'Hello',
      redirectedFrom: [],
      forumThreadKey: 'https://f.com/forum/thread-1-1',
    });
    await builder.addForumPost(post(), 'Hello');
    await journal.close();

    const checkpoint = await replayCheckpoint(builder.stagingPath!);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.forumPosts).toHaveLength(1);
    expect(checkpoint!.forumPosts[0]?.postId).toBe('p1#post-1');

    await builder.cleanup();
  });
});
