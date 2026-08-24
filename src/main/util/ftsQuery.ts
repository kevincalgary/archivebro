/**
 * Quote each token individually so punctuation in a user's search string
 * can't be interpreted as FTS5 query syntax (e.g. a stray `"` or `-`).
 * Shared by the Library catalog (archiveRepo.ts) and the .sitearchive
 * per-archive search index (sitearchive/archiveReader.ts), which both run
 * the same kind of `MATCH` query against an FTS5 table.
 */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}
