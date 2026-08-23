import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/main/db/migrations';

// schema.ts describes the *current* fresh-install shape, so testing an
// upgrade path means reconstructing the shape an existing install would
// actually have had -- schema v1, before the integrity-hash columns
// existed -- rather than reusing schema.ts's DDL.
const SCHEMA_V1_SQL = `
CREATE TABLE archives (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  has_mhtml INTEGER NOT NULL DEFAULT 0,
  has_screenshot INTEGER NOT NULL DEFAULT 0,
  has_text INTEGER NOT NULL DEFAULT 0
);
`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_V1_SQL);
  db.prepare('INSERT INTO archives (id, canonical_url, title) VALUES (?, ?, ?)').run(
    'existing-id',
    'https://example.com/',
    'Pre-migration row',
  );
});

describe('runMigrations', () => {
  it('v1 -> v2 adds the integrity-hash columns without touching existing rows', () => {
    const finalVersion = runMigrations(db, 1, 2);
    expect(finalVersion).toBe(2);

    const row = db.prepare('SELECT * FROM archives WHERE id = ?').get('existing-id') as Record<string, unknown>;
    expect(row.title).toBe('Pre-migration row');
    expect(row.mhtml_sha256).toBeNull();
    expect(row.screenshot_sha256).toBeNull();
    expect(row.text_sha256).toBeNull();

    // Newly inserted rows can now populate the columns like any other.
    db.prepare('UPDATE archives SET mhtml_sha256 = ? WHERE id = ?').run('a'.repeat(64), 'existing-id');
    const updated = db.prepare('SELECT mhtml_sha256 FROM archives WHERE id = ?').get('existing-id') as {
      mhtml_sha256: string;
    };
    expect(updated.mhtml_sha256).toBe('a'.repeat(64));
  });

  it('is a no-op when already at or past the target version', () => {
    expect(runMigrations(db, 2, 2)).toBe(2);
    // No migration ran, so the v2 columns were never added.
    expect(() => db.prepare('SELECT mhtml_sha256 FROM archives').get()).toThrow();
  });
});
