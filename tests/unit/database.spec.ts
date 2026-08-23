import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/main/db/migrations';
import { SCHEMA_SQL } from '../../src/main/db/schema';

// openDatabase() itself opens a real file and touches Electron's app.getPath
// indirectly via the logger, so this exercises its actual init logic
// (SCHEMA_SQL then a schema_meta-driven runMigrations call) directly against
// an in-memory database instead of importing the module (which would pull in
// `electron`).
function initFreshDatabase(currentSchemaVersion: number): Database.Database {
  const instance = new Database(':memory:');
  instance.exec(SCHEMA_SQL);
  const versionRow = instance.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const currentVersion = versionRow ? Number(versionRow.value) : currentSchemaVersion;
  const finalVersion = runMigrations(instance, currentVersion, currentSchemaVersion);
  instance
    .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(finalVersion));
  return instance;
}

describe('database initialization', () => {
  it('a brand-new database is not re-migrated against columns SCHEMA_SQL already created', () => {
    // Regression test: a fresh install has no schema_meta row yet (schema.ts
    // just created everything in its current shape), which a naive
    // "no row means version 0" read would misinterpret as needing every
    // migration replayed -- including an ALTER TABLE ADD COLUMN for a
    // column that already exists -- and crash on first launch.
    expect(() => initFreshDatabase(2)).not.toThrow();
  });

  it('a fresh database ends up with the hash columns present and queryable', () => {
    const db = initFreshDatabase(2);
    expect(() => db.prepare('SELECT mhtml_sha256, screenshot_sha256, text_sha256 FROM archives').all()).not.toThrow();
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe('2');
  });
});
