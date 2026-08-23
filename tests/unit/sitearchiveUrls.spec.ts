import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  fragmentOf,
  isSameOriginOrSubdomain,
  isInScope,
  looksDestructive,
  looksLikeCrawlerTrap,
  looksNonContent,
  isDocumentUrl,
  isMediaUrl,
  isExecutableUrl,
  extensionOf,
} from '../../src/main/sitearchive/urlNormalize';

describe('normalizeUrl', () => {
  it('strips the fragment so #a and #b are the same resource', () => {
    expect(normalizeUrl('https://e.com/page#a')).toBe(normalizeUrl('https://e.com/page#b'));
    expect(normalizeUrl('https://e.com/page#a')).toBe('https://e.com/page');
  });

  it('keeps meaningful query strings but drops tracking parameters', () => {
    expect(normalizeUrl('https://e.com/p?id=5')).toBe('https://e.com/p?id=5');
    expect(normalizeUrl('https://e.com/p?id=5&utm_source=twitter&fbclid=xyz')).toBe('https://e.com/p?id=5');
    expect(normalizeUrl('https://e.com/p?gclid=abc')).toBe('https://e.com/p');
  });

  it('sorts query parameters so order does not create duplicates', () => {
    expect(normalizeUrl('https://e.com/p?b=2&a=1')).toBe(normalizeUrl('https://e.com/p?a=1&b=2'));
  });

  it('collapses a trailing slash on non-root paths but keeps the root slash', () => {
    expect(normalizeUrl('https://e.com/about/')).toBe('https://e.com/about');
    expect(normalizeUrl('https://e.com/')).toBe('https://e.com/');
  });

  it('lowercases the host but preserves path case', () => {
    expect(normalizeUrl('https://EXAMPLE.com/MyPage')).toBe('https://example.com/MyPage');
  });

  it('drops default ports', () => {
    expect(normalizeUrl('http://e.com:80/x')).toBe('http://e.com/x');
    expect(normalizeUrl('https://e.com:443/x')).toBe('https://e.com/x');
    expect(normalizeUrl('https://e.com:8443/x')).toBe('https://e.com:8443/x');
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('about', 'https://e.com/dir/page')).toBe('https://e.com/dir/about');
    expect(normalizeUrl('../up', 'https://e.com/dir/page')).toBe('https://e.com/up');
    expect(normalizeUrl('/root', 'https://e.com/dir/page')).toBe('https://e.com/root');
  });

  it('returns null for non-http schemes and garbage', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it('can keep the fragment when explicitly asked', () => {
    expect(normalizeUrl('https://e.com/p#frag', undefined, { keepFragment: true })).toBe('https://e.com/p#frag');
  });
});

describe('fragmentOf', () => {
  it('returns the fragment including the hash, or empty', () => {
    expect(fragmentOf('https://e.com/p#sec')).toBe('#sec');
    expect(fragmentOf('https://e.com/p')).toBe('');
  });
});

describe('isSameOriginOrSubdomain', () => {
  it('accepts the exact host and its subdomains', () => {
    expect(isSameOriginOrSubdomain('https://e.com/x', 'e.com')).toBe(true);
    expect(isSameOriginOrSubdomain('https://docs.e.com/x', 'e.com')).toBe(true);
  });

  it('rejects lookalike domains', () => {
    expect(isSameOriginOrSubdomain('https://note.com/x', 'e.com')).toBe(false);
    expect(isSameOriginOrSubdomain('https://e.com.evil.net/x', 'e.com')).toBe(false);
  });
});

describe('isInScope', () => {
  const base = {
    startOrigin: 'https://e.com',
    allowedDomains: [] as string[],
    includeExternalDomains: [] as string[],
  };

  it('allows the exact same origin', () => {
    expect(isInScope({ ...base, url: 'https://e.com/a' })).toBe(true);
    expect(isInScope({ ...base, url: 'https://e.com/deep/path?q=1' })).toBe(true);
  });

  it('treats a different port as a different origin (out of scope by default)', () => {
    expect(isInScope({ ...base, url: 'https://e.com:8443/a' })).toBe(false);
    expect(isInScope({ startOrigin: 'http://127.0.0.1:3000', allowedDomains: [], includeExternalDomains: [], url: 'http://127.0.0.1:9999/x' })).toBe(false);
  });

  it('treats a different scheme as a different origin', () => {
    expect(isInScope({ ...base, url: 'http://e.com/a' })).toBe(false);
  });

  it('does not follow subdomains unless the user opts in', () => {
    expect(isInScope({ ...base, url: 'https://blog.e.com/a' })).toBe(false);
    expect(isInScope({ ...base, url: 'https://blog.e.com/a', allowedDomains: ['e.com'] })).toBe(true);
  });

  it('blocks unrelated domains -- this is what stops crawling the whole internet', () => {
    expect(isInScope({ ...base, url: 'https://other.com/a' })).toBe(false);
  });

  it('allows explicitly listed extra domains (including their subdomains) only', () => {
    expect(isInScope({ ...base, url: 'https://cdn.net/a', allowedDomains: ['cdn.net'] })).toBe(true);
    expect(isInScope({ ...base, url: 'https://img.cdn.net/a', allowedDomains: ['cdn.net'] })).toBe(true);
    expect(isInScope({ ...base, url: 'https://evil.net/a', allowedDomains: ['cdn.net'] })).toBe(false);
    expect(isInScope({ ...base, url: 'https://cdn.net.evil.com/a', allowedDomains: ['cdn.net'] })).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isInScope({ ...base, url: 'mailto:a@e.com' })).toBe(false);
  });
});

describe('looksDestructive', () => {
  it('flags logout/delete style links', () => {
    expect(looksDestructive('https://e.com/logout')).toBe(true);
    expect(looksDestructive('https://e.com/account/delete')).toBe(true);
    expect(looksDestructive('https://e.com/x?action=delete')).toBe(true);
    expect(looksDestructive('https://e.com/unsubscribe/')).toBe(true);
  });

  it('does not flag ordinary content links', () => {
    expect(looksDestructive('https://e.com/about')).toBe(false);
    expect(looksDestructive('https://e.com/products/deleted-scenes')).toBe(false);
  });
});

describe('looksLikeCrawlerTrap', () => {
  it('flags endless query permutations', () => {
    const many = 'https://e.com/x?' + Array.from({ length: 15 }, (_, i) => `p${i}=${i}`).join('&');
    expect(looksLikeCrawlerTrap(many)).toBe(true);
  });

  it('flags calendar-style infinite pagination', () => {
    expect(looksLikeCrawlerTrap('https://e.com/calendar/view?year=2031&month=7')).toBe(true);
  });

  it('flags pathological path repetition', () => {
    expect(looksLikeCrawlerTrap('https://e.com/a/b/a/b/a/b/a/b')).toBe(true);
  });

  it('flags absurdly deep or long URLs', () => {
    expect(looksLikeCrawlerTrap('https://e.com/' + Array.from({ length: 25 }, (_, i) => `s${i}`).join('/'))).toBe(true);
    expect(looksLikeCrawlerTrap('https://e.com/' + 'x'.repeat(2100))).toBe(true);
  });

  it('leaves normal URLs alone', () => {
    expect(looksLikeCrawlerTrap('https://e.com/products/widget?color=blue')).toBe(false);
    expect(looksLikeCrawlerTrap('https://e.com/blog/2024/01/a-post')).toBe(false);
  });
});

describe('content type helpers', () => {
  it('identifies documents, media, and executables by extension', () => {
    expect(isDocumentUrl('https://e.com/a.pdf')).toBe(true);
    expect(isDocumentUrl('https://e.com/a.html')).toBe(false);
    expect(isMediaUrl('https://e.com/v.mp4')).toBe(true);
    expect(isMediaUrl('https://e.com/a.png')).toBe(false);
    expect(isExecutableUrl('https://e.com/setup.exe')).toBe(true);
    expect(isExecutableUrl('https://e.com/app.dmg')).toBe(true);
    expect(isExecutableUrl('https://e.com/readme.txt')).toBe(false);
  });

  it('extracts extensions safely', () => {
    expect(extensionOf('https://e.com/a/b/file.TAR')).toBe('tar');
    expect(extensionOf('https://e.com/noext')).toBe('');
    expect(extensionOf('garbage')).toBe('');
  });
});

describe('looksNonContent', () => {
  const U = 'https://example.com';

  it('skips sign-in, registration and account routes', () => {
    for (const p of ['/login', '/log-in', '/signin', '/sign-in', '/register', '/signup', '/forum/login', '/en/account', '/lost-password']) {
      expect(looksNonContent(`${U}${p}`), p).toBe(true);
    }
  });

  it('skips search endpoints and per-user pages', () => {
    for (const p of ['/search', '/forums/search', '/members', '/members/user-1', '/profile', '/forum/members/bob']) {
      expect(looksNonContent(`${U}${p}`), p).toBe(true);
    }
  });

  it('skips posting and subscription forms', () => {
    for (const p of ['/new-thread', '/create-thread', '/post-thread', '/threads/5/reply', '/subscribe', '/checkout']) {
      expect(looksNonContent(`${U}${p}`), p).toBe(true);
    }
  });

  it('skips query-driven equivalents', () => {
    for (const q of ['?do=login', '?action=search', '?mode=register', '?view=profile']) {
      expect(looksNonContent(`${U}/index.php${q}`), q).toBe(true);
    }
  });

  it('does not skip content whose path merely contains a keyword', () => {
    // Over-matching here silently discards real pages, which is a worse
    // failure than wasting a slot on a login form.
    const contentPaths = [
      '/research',
      '/research/2024',
      '/accounts-payable',
      '/remember-when',
      '/membership-benefits',
      '/profiles-of-cars',
      '/searching-for-answers',
      '/articles/how-to-login-safely',
      '/threads/dead-battery-how-to-open-hood.367500',
      '/forums/range-rover-sport.232',
      '/reply-all-considered-harmful',
      '/',
    ];
    for (const p of contentPaths) {
      expect(looksNonContent(`${U}${p}`), p).toBe(false);
    }
  });

  it('does not crash on a malformed URL', () => {
    expect(looksNonContent('not a url')).toBe(false);
  });
});
