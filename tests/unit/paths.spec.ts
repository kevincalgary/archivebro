import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isValidArchiveId, assertValidArchiveId, archiveDirFor, archiveFilePaths } from '../../src/main/util/paths';

const VALID_UUID = '3c1f9c9e-2a4b-4a3e-9c7a-1a2b3c4d5e6f';

describe('isValidArchiveId', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidArchiveId(VALID_UUID)).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidArchiveId('../../../etc/passwd')).toBe(false);
    expect(isValidArchiveId('..')).toBe(false);
    expect(isValidArchiveId('a/../../b')).toBe(false);
  });

  it('rejects non-UUID strings', () => {
    expect(isValidArchiveId('not-a-uuid')).toBe(false);
    expect(isValidArchiveId('')).toBe(false);
    expect(isValidArchiveId('12345')).toBe(false);
  });
});

describe('assertValidArchiveId', () => {
  it('throws for an invalid id instead of silently continuing', () => {
    expect(() => assertValidArchiveId('../escape')).toThrow();
  });
  it('does not throw for a valid id', () => {
    expect(() => assertValidArchiveId(VALID_UUID)).not.toThrow();
  });
});

describe('archiveDirFor', () => {
  const root = '/tmp/archives';

  it('joins a valid id under the root', () => {
    expect(archiveDirFor(root, VALID_UUID)).toBe(path.resolve(root, VALID_UUID));
  });

  it('throws rather than resolving outside the root for a traversal id', () => {
    expect(() => archiveDirFor(root, '../../etc')).toThrow();
  });

  it('throws for an id crafted to look like an absolute path', () => {
    expect(() => archiveDirFor(root, '/etc/passwd')).toThrow();
  });
});

describe('archiveFilePaths', () => {
  it('returns the documented file layout under the archive directory', () => {
    const paths = archiveFilePaths('/tmp/archives', VALID_UUID);
    expect(paths.mhtml.endsWith('page.mhtml')).toBe(true);
    expect(paths.screenshot.endsWith('screenshot.png')).toBe(true);
    expect(paths.text.endsWith('text.txt')).toBe(true);
    expect(paths.metadata.endsWith('metadata.json')).toBe(true);
    expect(paths.dir).toBe(path.resolve('/tmp/archives', VALID_UUID));
  });
});
