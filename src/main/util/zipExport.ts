import { createWriteStream } from 'node:fs';

/**
 * `archiver` ships as an ESM-only package (no CommonJS build), while this
 * main process compiles to CommonJS -- so it has to be loaded via a
 * dynamic `import()` rather than `require()`. Zip an archive's directory
 * (page.mhtml, screenshot.png, text.txt, metadata.json) for export.
 */
export async function zipArchiveDirectory(sourceDir: string, destZipPath: string): Promise<void> {
  const { ZipArchive } = await import('archiver');

  return new Promise((resolve, reject) => {
    const output = createWriteStream(destZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err: unknown) => reject(err));
    output.on('error', (err: unknown) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}
