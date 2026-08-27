import { describe, it, expect } from 'vitest';
import { retryableFailures, inferDepth } from '../../src/main/sitearchive/retryFailedPages';
import type { ArchivedPageEntry, CaptureFailureEntry } from '../../src/shared/sitearchiveTypes';

function failure(overrides: Partial<CaptureFailureEntry> = {}): CaptureFailureEntry {
  return {
    url: 'https://example.com/page',
    kind: 'fetch-failed',
    message: 'boom',
    discoveredOn: null,
    ...overrides,
  };
}

describe('retryableFailures', () => {
  it('keeps genuine page-capture-attempt failures', () => {
    const kinds = ['fetch-failed', 'http-error', 'timeout', 'too-large', 'redirect-loop', 'render-process-gone', 'render-failed', 'serialize-failed', 'disk-full', 'interrupted'] as const;
    const failures = kinds.map((kind, i) => failure({ kind, url: `https://example.com/${i}` }));
    const result = retryableFailures(failures);
    expect(result.map((f) => f.kind).sort()).toEqual([...kinds].sort());
  });

  it('excludes intentional link-level skips, asset-level failures, and administrative records', () => {
    const notRetryable = [
      'skipped-scope',
      'skipped-non-http',
      'skipped-duplicate',
      'skipped-trap',
      'skipped-sensitive',
      'skipped-non-content',
      'skipped-budget',
      'stopped-at-limit',
      'cancelled',
    ] as const;
    const failures = notRetryable.map((kind, i) => failure({ kind, url: `https://example.com/${i}` }));
    expect(retryableFailures(failures)).toHaveLength(0);
  });

  it('retries a URL at most once, even if it was recorded as failed more than once', () => {
    const failures = [
      failure({ url: 'https://example.com/dup', kind: 'timeout', message: 'first' }),
      failure({ url: 'https://example.com/dup', kind: 'fetch-failed', message: 'second' }),
    ];
    const result = retryableFailures(failures);
    expect(result).toHaveLength(1);
    expect(result[0]!.message).toBe('first'); // first recorded wins
  });

  it('treats URLs that normalize to the same page as one retry, not two', () => {
    const failures = [
      failure({ url: 'https://example.com/page#section', kind: 'timeout' }),
      failure({ url: 'https://example.com/page', kind: 'fetch-failed' }),
    ];
    expect(retryableFailures(failures)).toHaveLength(1);
  });

  it('treats a disk-full failure as retryable, once the user has freed up space', () => {
    const failures = [failure({ url: 'https://example.com/full', kind: 'disk-full', message: 'Ran out of disk space.' })];
    const result = retryableFailures(failures);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('disk-full');
  });

  it('preserves original order otherwise', () => {
    const failures = [
      failure({ url: 'https://example.com/a', kind: 'timeout' }),
      failure({ url: 'https://example.com/b', kind: 'http-error' }),
      failure({ url: 'https://example.com/c', kind: 'fetch-failed' }),
    ];
    expect(retryableFailures(failures).map((f) => f.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });
});

describe('inferDepth', () => {
  function page(overrides: Partial<ArchivedPageEntry> = {}): ArchivedPageEntry {
    return {
      pageId: 'p1',
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      title: 'Home',
      depth: 0,
      capturedAt: new Date().toISOString(),
      htmlPath: 'pages/p1.html',
      htmlSha256: 'x',
      screenshotPath: null,
      screenshotSha256: null,
      textPath: null,
      textSha256: null,
      redirectedFrom: [],
      contentType: 'text/html',
      byteSize: 0,
      ...overrides,
    };
  }

  it('is one deeper than the page that discovered it', () => {
    const byUrl = new Map([['https://example.com/', page({ depth: 2 })]]);
    expect(inferDepth('https://example.com/', byUrl)).toBe(3);
  });

  it('falls back to 0 when there is no discovering page', () => {
    expect(inferDepth(null, new Map())).toBe(0);
  });

  it('falls back to 0 when the discovering page was never actually captured', () => {
    expect(inferDepth('https://example.com/missing', new Map())).toBe(0);
  });
});
