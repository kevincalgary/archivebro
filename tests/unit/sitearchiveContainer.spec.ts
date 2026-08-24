import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SiteArchiveBuilder, sha256 } from '../../src/main/sitearchive/archiveWriter';
import { openSiteArchive, safeEntryName, resolveInsideRoot, SiteArchiveError } from '../../src/main/sitearchive/archiveReader';
import { DEFAULT_SITE_SCOPE } from '../../src/shared/sitearchiveTypes';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function buildSampleArchive(finalPath: string) {
  const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
  await builder.init(tmp);

  const logo = Buffer.from('fake-png-bytes');
  const a1 = await builder.addAsset(logo, 'image/png', 'https://example.com/logo.png');
  // Same bytes from a different URL must dedupe to the same asset.
  const a2 = await builder.addAsset(logo, 'image/png', 'https://example.com/other/logo.png');

  await builder.addPage({
    pageId: 'p1',
    originalUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    normalizedUrl: 'https://example.com/',
    title: 'Home',
    depth: 0,
    html: '<html><body><h1>Home</h1></body></html>',
    screenshot: Buffer.from('png'),
    text: 'Home',
    redirectedFrom: [],
  });
  await builder.addPage({
    pageId: 'p2',
    originalUrl: 'https://example.com/about',
    finalUrl: 'https://example.com/about',
    normalizedUrl: 'https://example.com/about',
    title: 'About',
    depth: 1,
    html: '<html><body><h1>About</h1></body></html>',
    screenshot: null,
    text: 'About',
    redirectedFrom: ['https://example.com/about-us'],
  });

  await builder.addFailure({ url: 'https://example.com/missing', kind: 'http-error', message: '404', discoveredOn: 'https://example.com/' });

  const { manifest, fileSizeBytes } = await builder.finalize({
    finalPath,
    startUrl: 'https://example.com/',
    startFinalUrl: 'https://example.com/',
    siteTitle: 'Example',
    scope: DEFAULT_SITE_SCOPE,
  });
  await builder.cleanup();
  return { manifest, fileSizeBytes, dedupedHash: a1.sha256, secondHash: a2.sha256 };
}

describe('safeEntryName', () => {
  it('accepts normal archive-relative paths', () => {
    expect(safeEntryName('pages/p1.html')).toBe('pages/p1.html');
    expect(safeEntryName('assets/abc123.png')).toBe('assets/abc123.png');
  });

  it('rejects path traversal in every form', () => {
    expect(safeEntryName('../etc/passwd')).toBeNull();
    expect(safeEntryName('pages/../../etc/passwd')).toBeNull();
    expect(safeEntryName('a/../../b')).toBeNull();
    expect(safeEntryName('/etc/passwd')).toBeNull();
    expect(safeEntryName('..')).toBeNull();
  });

  it('rejects Windows-style absolute and UNC paths', () => {
    expect(safeEntryName('C:\\Windows\\system32')).toBeNull();
    expect(safeEntryName('C:/Windows/system32')).toBeNull();
    expect(safeEntryName('//server/share/file')).toBeNull();
    expect(safeEntryName('pages\\p1.html')).toBeNull();
  });

  it('rejects null bytes, directories, and absurdly long names', () => {
    expect(safeEntryName('pages/p1\0.html')).toBeNull();
    expect(safeEntryName('pages/')).toBeNull();
    expect(safeEntryName('a'.repeat(2000))).toBeNull();
    expect(safeEntryName('')).toBeNull();
  });
});

describe('resolveInsideRoot', () => {
  it('resolves a safe relative path under the root', () => {
    const r = resolveInsideRoot('/tmp/root', 'pages/p1.html');
    expect(r).toBe(path.resolve('/tmp/root', 'pages/p1.html'));
  });

  it('refuses to escape the root', () => {
    expect(resolveInsideRoot('/tmp/root', '../outside')).toBeNull();
    expect(resolveInsideRoot('/tmp/root', '/etc/passwd')).toBeNull();
  });
});

describe('SiteArchiveBuilder -> openSiteArchive round trip', () => {
  it('writes a readable archive whose manifest describes its contents', async () => {
    const out = path.join(tmp, 'Example.sitearchive');
    const { manifest } = await buildSampleArchive(out);

    expect(manifest.pages).toHaveLength(2);
    expect(manifest.siteTitle).toBe('Example');

    const archive = await openSiteArchive(out);
    try {
      expect(archive.manifest.archiveId).toBe(manifest.archiveId);
      expect(archive.manifest.pages).toHaveLength(2);
      expect(archive.entryPageId).toBe('p1');

      const html = await archive.readEntry('pages/p1.html', archive.manifest.pages[0]!.htmlSha256);
      expect(html.toString('utf8')).toContain('<h1>Home</h1>');
    } finally {
      archive.close();
    }
  });

  it('deduplicates identical asset bytes into a single stored entry', async () => {
    const out = path.join(tmp, 'Dedupe.sitearchive');
    const { manifest, dedupedHash, secondHash } = await buildSampleArchive(out);

    expect(secondHash).toBe(dedupedHash);
    expect(manifest.assets).toHaveLength(1);
    // ...but both original URLs still map to it.
    expect(manifest.assets[0]!.sourceUrls).toEqual([
      'https://example.com/logo.png',
      'https://example.com/other/logo.png',
    ]);
  });

  it('routes redirect sources to the page they landed on', async () => {
    const out = path.join(tmp, 'Redirects.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      const viaRedirect = archive.lookupRoute('https://example.com/about-us');
      expect(viaRedirect?.target).toEqual({ type: 'page', pageId: 'p2' });
    } finally {
      archive.close();
    }
  });

  it('records failures in the manifest', async () => {
    const out = path.join(tmp, 'Failures.sitearchive');
    const { manifest } = await buildSampleArchive(out);
    expect(manifest.failures).toHaveLength(1);
    expect(manifest.failures[0]!.kind).toBe('http-error');
  });

  it('ships a queryable index.sqlite catalog', async () => {
    const out = path.join(tmp, 'Indexed.sitearchive');
    const { manifest } = await buildSampleArchive(out);
    expect(manifest.indexPath).toBe('index.sqlite');
    expect(manifest.indexSha256).toBeTruthy();

    const archive = await openSiteArchive(out);
    try {
      const buf = await archive.readEntry('index.sqlite', manifest.indexSha256);
      // SQLite files start with this magic string.
      expect(buf.subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
    } finally {
      archive.close();
    }
  });

  it('writes atomically -- no leftover temp file, and the final name only appears on success', async () => {
    const out = path.join(tmp, 'Atomic.sitearchive');
    await buildSampleArchive(out);
    const siblings = await fs.readdir(tmp);
    expect(siblings.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(siblings).toContain('Atomic.sitearchive');
  });

  it('cleans up staging data after finalize', async () => {
    const out = path.join(tmp, 'Cleaned.sitearchive');
    await buildSampleArchive(out);
    const siblings = await fs.readdir(tmp);
    expect(siblings.some((f) => f.startsWith('sitearchive-staging-'))).toBe(false);
  });
});

describe('Full-text search inside an opened archive', () => {
  it('matches the page whose extracted text contains the term, not other pages', async () => {
    const out = path.join(tmp, 'Searchable.sitearchive');
    // buildSampleArchive's p1 ("Home") has text 'Home', p2 ("About") has
    // text 'About' -- distinct enough to prove search finds the right page,
    // not just any page.
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      const homeResults = archive.search('Home');
      expect(homeResults.map((r) => r.pageId)).toEqual(['p1']);

      const aboutResults = archive.search('About');
      expect(aboutResults.map((r) => r.pageId)).toEqual(['p2']);

      expect(archive.search('no-such-term-anywhere')).toHaveLength(0);
    } finally {
      archive.close();
    }
  });

  it('is inert (not an error) on punctuation that would otherwise be invalid FTS5 syntax', async () => {
    const out = path.join(tmp, 'SearchableSyntax.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      // A bare quote, dash, or asterisk are all meaningful in raw FTS5
      // query syntax -- sanitizeFtsQuery must neutralize them rather than
      // this throwing back up through search().
      expect(() => archive.search('"unterminated')).not.toThrow();
      expect(() => archive.search('- leading dash')).not.toThrow();
      expect(() => archive.search('*')).not.toThrow();
    } finally {
      archive.close();
    }
  });

  it('an empty or whitespace-only query returns no results rather than matching everything', async () => {
    const out = path.join(tmp, 'SearchableEmpty.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      expect(archive.search('')).toHaveLength(0);
      expect(archive.search('   ')).toHaveLength(0);
    } finally {
      archive.close();
    }
  });
});

describe('SiteArchiveBuilder concurrent writes (parallel crawling)', () => {
  // Pages are now captured in parallel (see crawler.ts), so two workers can
  // genuinely call addAsset/addResponse for identical bytes before either
  // has finished writing -- addAsset/addResponse must not race in that case
  // (see the in-flight-write guard in archiveWriter.ts). Calling both
  // WITHOUT awaiting the first (Promise.all) is what actually exercises the
  // race a sequential await never would.
  it('addAsset: two concurrent callers for identical bytes write the file once and keep both sourceUrls', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    const bytes = Buffer.from('shared-logo-bytes');
    const [a, b] = await Promise.all([
      builder.addAsset(bytes, 'image/png', 'https://example.com/page-a/logo.png'),
      builder.addAsset(bytes, 'image/png', 'https://example.com/page-b/logo.png'),
    ]);

    expect(a.sha256).toBe(b.sha256);
    // Both calls must return the SAME entry object -- not two separate
    // entries for the same hash -- since that's what proves only one write
    // happened and the second call joined it rather than racing it.
    expect(a).toBe(b);
    expect(a.sourceUrls.sort()).toEqual(['https://example.com/page-a/logo.png', 'https://example.com/page-b/logo.png']);

    const out = path.join(tmp, 'Concurrent.sitearchive');
    await builder.addPage({
      pageId: 'p1',
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      title: 'Home',
      depth: 0,
      html: '<html></html>',
      screenshot: null,
      text: null,
      redirectedFrom: [],
    });
    const { manifest } = await builder.finalize({
      finalPath: out,
      startUrl: 'https://example.com/',
      startFinalUrl: 'https://example.com/',
      siteTitle: 'Example',
      scope: DEFAULT_SITE_SCOPE,
    });
    // Exactly one asset entry on disk, not two competing writes of the same bytes.
    expect(manifest.assets).toHaveLength(1);

    const archive = await openSiteArchive(out);
    try {
      const stored = await archive.readEntry(manifest.assets[0]!.path, manifest.assets[0]!.sha256);
      expect(stored.equals(bytes)).toBe(true);
    } finally {
      archive.close();
    }
  });

  it('addResponse: two concurrent callers for identical bytes write the file once', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    const bytes = Buffer.from('{"shared":"response"}');
    const [a, b] = await Promise.all([
      builder.addResponse(bytes, 'https://example.com/api/a', 'https://example.com/api/a', 'application/json', 200),
      builder.addResponse(bytes, 'https://example.com/api/b', 'https://example.com/api/b', 'application/json', 200),
    ]);

    expect(a).toBe(b);
    expect(a.sha256).toBe(b.sha256);
  });

  it('a hash already fully stored before a later call arrives is served from the cache, not written again', async () => {
    const builder = new SiteArchiveBuilder(crypto.randomUUID(), '0.1.0');
    await builder.init(tmp);

    const bytes = Buffer.from('sequential-bytes');
    const first = await builder.addAsset(bytes, 'image/png', 'https://example.com/one.png');
    const second = await builder.addAsset(bytes, 'image/png', 'https://example.com/two.png');

    expect(second).toBe(first);
    expect(first.sourceUrls).toEqual(['https://example.com/one.png', 'https://example.com/two.png']);
  });
});

describe('openSiteArchive rejects malformed and malicious archives', () => {
  it('rejects a file that is not a zip at all', async () => {
    const bogus = path.join(tmp, 'bogus.sitearchive');
    await fs.writeFile(bogus, 'this is definitely not a zip file');
    await expect(openSiteArchive(bogus)).rejects.toThrow();
  });

  it('rejects a nonexistent file with a specific code', async () => {
    await expect(openSiteArchive(path.join(tmp, 'nope.sitearchive'))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects a zip with no manifest.json', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'nomanifest.sitearchive');
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append('hello', { name: 'pages/p1.html' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'missing-manifest' });
  });

  it('rejects a manifest that is not valid JSON', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'badjson.sitearchive');
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append('{not valid json', { name: 'manifest.json' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'malformed-manifest' });
  });

  it('rejects a manifest whose shape is wrong', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'badshape.sitearchive');
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append(JSON.stringify({ formatVersion: 1 }), { name: 'manifest.json' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'malformed-manifest' });
  });

  it('rejects an archive claiming a newer format version', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'future.sitearchive');
    const manifest = {
      formatVersion: 999,
      archiveId: 'x',
      startUrl: 'https://e.com/',
      startFinalUrl: 'https://e.com/',
      siteTitle: 'x',
      capturedAt: new Date().toISOString(),
      scope: DEFAULT_SITE_SCOPE,
      pages: [],
      assets: [],
      responses: [],
      routes: [],
      failures: [],
      appVersion: '9.9.9',
      totalUncompressedBytes: 0,
      indexPath: null,
      indexSha256: null,
    };
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'unsupported-version' });
  });

  it('rejects a manifest that references a path escaping the archive', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'traversal.sitearchive');
    const manifest = {
      formatVersion: 1,
      archiveId: 'x',
      startUrl: 'https://e.com/',
      startFinalUrl: 'https://e.com/',
      siteTitle: 'x',
      capturedAt: new Date().toISOString(),
      scope: DEFAULT_SITE_SCOPE,
      pages: [
        {
          pageId: 'p1',
          originalUrl: 'https://e.com/',
          finalUrl: 'https://e.com/',
          normalizedUrl: 'https://e.com/',
          title: 'x',
          depth: 0,
          capturedAt: new Date().toISOString(),
          // Hostile: tries to escape the archive root.
          htmlPath: '../../../../etc/passwd',
          htmlSha256: 'deadbeef',
          screenshotPath: null,
          screenshotSha256: null,
          textPath: null,
          textSha256: null,
          redirectedFrom: [],
          contentType: 'text/html',
          byteSize: 1,
        },
      ],
      assets: [],
      responses: [],
      routes: [],
      failures: [],
      appVersion: '0.1.0',
      totalUncompressedBytes: 0,
      indexPath: null,
      indexSha256: null,
    };
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('refuses to serve an entry whose bytes do not match the manifest checksum', async () => {
    const out = path.join(tmp, 'tampered.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      // Ask for a real entry but assert a checksum it cannot match --
      // this is what a tampered archive looks like from the reader's side.
      await expect(archive.readEntry('pages/p1.html', 'f'.repeat(64))).rejects.toMatchObject({
        code: 'checksum-mismatch',
      });
    } finally {
      archive.close();
    }
  });

  it('refuses to read an entry path that is unsafe, even if asked directly', async () => {
    const out = path.join(tmp, 'safe.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      await expect(archive.readEntry('../../../etc/passwd', null)).rejects.toMatchObject({ code: 'unsafe-path' });
    } finally {
      archive.close();
    }
  });

  it('refuses to read an entry that is not present in the container', async () => {
    const out = path.join(tmp, 'missing.sitearchive');
    await buildSampleArchive(out);
    const archive = await openSiteArchive(out);
    try {
      await expect(archive.readEntry('pages/does-not-exist.html', null)).rejects.toMatchObject({
        code: 'entry-missing',
      });
    } finally {
      archive.close();
    }
  });

  it('rejects a decompression bomb by compression ratio before reading it', async () => {
    const { ZipArchive } = await import('archiver');
    const out = path.join(tmp, 'bomb.sitearchive');
    // 40MB of zeros compresses to almost nothing -- ratio far above the cap.
    const bomb = Buffer.alloc(40 * 1024 * 1024, 0);
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(out);
      const zip = new ZipArchive({ zlib: { level: 9 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append(JSON.stringify({ formatVersion: 1, archiveId: 'x', pages: [], assets: [], routes: [], responses: [], failures: [] }), {
        name: 'manifest.json',
      });
      zip.append(bomb, { name: 'assets/bomb.bin' });
      void zip.finalize();
    });
    await expect(openSiteArchive(out)).rejects.toMatchObject({ code: 'compression-bomb' });
  });
});
