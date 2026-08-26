import { describe, it, expect } from 'vitest';
import {
  looksLikeForumPagination,
  looksLikeAttachment,
  looksLikeAvatarOrEmoji,
  looksLikePrintOrAlternateView,
  threadKeyOf,
  sectionKeyOf,
} from '../../src/main/sitearchive/forumLinks';
import { looksNonContent, normalizeUrl } from '../../src/main/sitearchive/urlNormalize';

describe('looksLikeForumPagination', () => {
  it('recognizes ?page=N', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1?page=2')).toBe(true);
  });

  it('recognizes /page/N path segments', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1/page/2')).toBe(true);
  });

  it('recognizes &start=N offsets', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1?start=40')).toBe(true);
  });

  it('recognizes &p=N', () => {
    expect(looksLikeForumPagination('https://f.com/showthread.php?t=1&p=2')).toBe(true);
  });

  it('recognizes pagination-shaped link text even without a matching URL shape', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1?x=1', 'Next')).toBe(true);
    expect(looksLikeForumPagination('https://f.com/thread-1?x=1', '3')).toBe(true);
    expect(looksLikeForumPagination('https://f.com/thread-1?x=1', '»')).toBe(true);
  });

  it('does not flag an ordinary content link', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1', 'Read more')).toBe(false);
  });

  it('does not flag arbitrary link text as pagination', () => {
    expect(looksLikeForumPagination('https://f.com/thread-1', 'Reply to this post')).toBe(false);
  });
});

describe('looksLikeAttachment', () => {
  it('recognizes common document extensions', () => {
    expect(looksLikeAttachment('https://f.com/files/manual.pdf')).toBe(true);
    expect(looksLikeAttachment('https://f.com/files/report.docx')).toBe(true);
  });

  it('recognizes /attachments/ path shapes with no extension', () => {
    expect(looksLikeAttachment('https://f.com/forum/attachments/photo')).toBe(true);
  });

  it('recognizes attachmentid= query shapes with no extension', () => {
    expect(looksLikeAttachment('https://f.com/attachment.php?attachmentid=7')).toBe(true);
  });

  it('does not flag an ordinary thread link', () => {
    expect(looksLikeAttachment('https://f.com/forum/thread-1-1')).toBe(false);
  });
});

describe('looksLikeAvatarOrEmoji', () => {
  it('recognizes /avatars/ and /emoji/ paths', () => {
    expect(looksLikeAvatarOrEmoji('https://f.com/forum/avatars/user-1.png')).toBe(true);
    expect(looksLikeAvatarOrEmoji('https://f.com/forum/emoji/smile.png')).toBe(true);
  });

  it('recognizes /smilies/ and /customavatars/', () => {
    expect(looksLikeAvatarOrEmoji('https://f.com/images/smilies/happy.gif')).toBe(true);
    expect(looksLikeAvatarOrEmoji('https://f.com/customavatars/1234.png')).toBe(true);
  });

  it('does not flag an ordinary post image', () => {
    expect(looksLikeAvatarOrEmoji('https://f.com/uploads/photo.jpg')).toBe(false);
  });
});

describe('looksLikePrintOrAlternateView', () => {
  it('recognizes ?mode=print', () => {
    expect(looksLikePrintOrAlternateView('https://f.com/forum/thread-1-1?mode=print')).toBe(true);
  });

  it('recognizes /printthread.php-style paths', () => {
    expect(looksLikePrintOrAlternateView('https://f.com/printthread.php?t=1')).toBe(true);
  });

  it('recognizes a /print/ path segment', () => {
    expect(looksLikePrintOrAlternateView('https://f.com/forum/thread-1/print/')).toBe(true);
  });

  it('does not flag an ordinary thread link', () => {
    expect(looksLikePrintOrAlternateView('https://f.com/forum/thread-1-1')).toBe(false);
  });
});

describe('threadKeyOf / sectionKeyOf', () => {
  function n(url: string): string {
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error('failed to normalize in test setup');
    return normalized;
  }

  it('collapses ?page=N pagination to the same key', () => {
    expect(threadKeyOf(n('https://f.com/forum/thread-1-1'))).toBe(threadKeyOf(n('https://f.com/forum/thread-1-1?page=2')));
  });

  it('collapses /page/N pagination to the same key', () => {
    expect(threadKeyOf(n('https://f.com/forum/thread-2-1'))).toBe(threadKeyOf(n('https://f.com/forum/thread-2-1/page/2')));
  });

  it('collapses &start=N offsets to the same key', () => {
    expect(threadKeyOf(n('https://f.com/showthread.php?t=1'))).toBe(threadKeyOf(n('https://f.com/showthread.php?t=1&start=40')));
  });

  it('keeps content-selecting query params that are not pagination', () => {
    expect(threadKeyOf(n('https://f.com/showthread.php?t=1'))).not.toBe(threadKeyOf(n('https://f.com/showthread.php?t=2')));
  });

  it('gives two different threads two different keys', () => {
    expect(threadKeyOf(n('https://f.com/forum/thread-1-1'))).not.toBe(threadKeyOf(n('https://f.com/forum/thread-1-2')));
  });

  it('sectionKeyOf collapses section pagination the same way', () => {
    expect(sectionKeyOf(n('https://f.com/forum/section-1'))).toBe(sectionKeyOf(n('https://f.com/forum/section-1?page=2')));
  });
});

describe('looksNonContent with includeProfiles', () => {
  it('skips member/profile routes by default', () => {
    expect(looksNonContent('https://f.com/forum/members/user-1')).toBe(true);
  });

  it('still skips login/search/account routes even when includeProfiles is set', () => {
    expect(looksNonContent('https://f.com/forum/login', { includeProfiles: true })).toBe(true);
    expect(looksNonContent('https://f.com/forum/search', { includeProfiles: true })).toBe(true);
  });

  it('treats member/profile routes as content when includeProfiles is set', () => {
    expect(looksNonContent('https://f.com/forum/members/user-1', { includeProfiles: true })).toBe(false);
    expect(looksNonContent('https://f.com/forum/profile/42', { includeProfiles: true })).toBe(false);
  });

  it('does not affect ordinary content routes either way', () => {
    expect(looksNonContent('https://f.com/forum/thread-1-1')).toBe(false);
    expect(looksNonContent('https://f.com/forum/thread-1-1', { includeProfiles: true })).toBe(false);
  });
});
