import { describe, it, expect } from 'vitest';
import {
  isSafeRemoteUrl,
  isSafeExternalUrl,
  resolveAddressBarInput,
  canonicalizeUrl,
  extractDomain,
  buildSearchUrl,
} from '../../src/main/browser/urlUtils';

describe('isSafeRemoteUrl', () => {
  it('allows http and https', () => {
    expect(isSafeRemoteUrl('https://example.com')).toBe(true);
    expect(isSafeRemoteUrl('http://example.com')).toBe(true);
  });

  it('rejects internal and dangerous schemes', () => {
    expect(isSafeRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeRemoteUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeRemoteUrl('chrome://settings')).toBe(false);
    expect(isSafeRemoteUrl('archive://some-id/page.mhtml')).toBe(false);
    expect(isSafeRemoteUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
  });

  it('rejects garbage input instead of throwing', () => {
    expect(isSafeRemoteUrl('not a url')).toBe(false);
    expect(isSafeRemoteUrl('')).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows mailto in addition to http(s)', () => {
    expect(isSafeExternalUrl('mailto:a@b.com')).toBe(true);
  });
  it('rejects file and javascript', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('resolveAddressBarInput', () => {
  const engine = 'https://duckduckgo.com/?q=%s';

  it('passes through a well-formed http(s) URL unchanged', () => {
    expect(resolveAddressBarInput('https://example.com/path', engine)).toBe('https://example.com/path');
  });

  it('adds https:// to a bare domain', () => {
    expect(resolveAddressBarInput('example.com', engine)).toBe('https://example.com');
  });

  it('sends free text to the search engine', () => {
    expect(resolveAddressBarInput('best pizza near me', engine)).toBe(
      'https://duckduckgo.com/?q=best%20pizza%20near%20me',
    );
  });

  it('never resolves to an internal/unsafe scheme, even if typed directly', () => {
    const result = resolveAddressBarInput('javascript:alert(1)', engine);
    expect(result.startsWith('javascript:')).toBe(false);
    expect(result).toContain('duckduckgo.com');
  });

  it('never resolves to file:// even if typed directly', () => {
    const result = resolveAddressBarInput('file:///etc/passwd', engine);
    expect(result.startsWith('file:')).toBe(false);
  });

  it('handles empty input without throwing', () => {
    expect(() => resolveAddressBarInput('', engine)).not.toThrow();
  });
});

describe('canonicalizeUrl', () => {
  it('strips the hash fragment', () => {
    expect(canonicalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('strips a trailing slash on non-root paths', () => {
    expect(canonicalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('keeps the root slash for a domain-only URL', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('two hash variants of the same page canonicalize to the same value', () => {
    expect(canonicalizeUrl('https://example.com/page#a')).toBe(canonicalizeUrl('https://example.com/page#b'));
  });
});

describe('extractDomain', () => {
  it('extracts the hostname', () => {
    expect(extractDomain('https://sub.example.com/path')).toBe('sub.example.com');
  });
  it('returns empty string for unparsable input', () => {
    expect(extractDomain('not a url')).toBe('');
  });
});

describe('buildSearchUrl', () => {
  it('substitutes %s', () => {
    expect(buildSearchUrl('cats', 'https://example.com/?q=%s')).toBe('https://example.com/?q=cats');
  });
  it('appends when there is no %s placeholder', () => {
    expect(buildSearchUrl('cats', 'https://example.com/search=')).toBe('https://example.com/search=cats');
  });
});
