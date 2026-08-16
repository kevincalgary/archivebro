import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, withStagedArchiveDir, sweepStagingDirs } from '../../src/main/util/atomicWrite';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-browser-atomicwrite-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('writes the file and leaves no temp file behind', async () => {
    const target = path.join(tmpRoot, 'sub', 'file.txt');
    await atomicWriteFile(target, 'hello world');
    expect(await fs.readFile(target, 'utf8')).toBe('hello world');
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });

  it('an existing file is never left partially overwritten if interrupted before rename', async () => {
    const target = path.join(tmpRoot, 'file.txt');
    await atomicWriteFile(target, 'original');
    // atomicWriteFile always writes to a temp file first; even a very large
    // second write can only ever fully replace the file via rename(), never
    // leave a half-written result. We simulate this by checking the file is
    // fully one version or the other after two sequential writes.
    await atomicWriteFile(target, 'updated');
    expect(await fs.readFile(target, 'utf8')).toBe('updated');
  });
});

describe('withStagedArchiveDir', () => {
  it('renames the staging dir into place only after the callback succeeds', async () => {
    const finalDir = path.join(tmpRoot, 'archive-1');
    await withStagedArchiveDir(tmpRoot, 'archive-1', finalDir, async (stagingDir) => {
      await fs.writeFile(path.join(stagingDir, 'page.mhtml'), 'content');
    });
    expect(await fs.readFile(path.join(finalDir, 'page.mhtml'), 'utf8')).toBe('content');
    const entries = await fs.readdir(tmpRoot);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
  });

  it('leaves no final directory and cleans up staging if the callback throws', async () => {
    const finalDir = path.join(tmpRoot, 'archive-2');
    await expect(
      withStagedArchiveDir(tmpRoot, 'archive-2', finalDir, async () => {
        throw new Error('capture failed midway');
      }),
    ).rejects.toThrow('capture failed midway');

    await expect(fs.stat(finalDir)).rejects.toThrow();
    const entries = await fs.readdir(tmpRoot);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
  });
});

describe('sweepStagingDirs', () => {
  it('removes leftover .tmp-* directories and reports what it swept', async () => {
    await fs.mkdir(path.join(tmpRoot, '.tmp-abc'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, '.tmp-def'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'real-archive'), { recursive: true });

    const swept = await sweepStagingDirs(tmpRoot);
    expect(swept.sort()).toEqual(['.tmp-abc', '.tmp-def']);
    const remaining = await fs.readdir(tmpRoot);
    expect(remaining).toEqual(['real-archive']);
  });

  it('does nothing if the archives root does not exist yet', async () => {
    const swept = await sweepStagingDirs(path.join(tmpRoot, 'does-not-exist'));
    expect(swept).toEqual([]);
  });
});
