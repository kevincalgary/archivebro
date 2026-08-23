import Database from 'better-sqlite3';
import { logger } from '../util/logger';
import { runMigrations } from './migrations';
import { SCHEMA_SQL } from './schema';

export const CURRENT_SCHEMA_VERSION = 2;

let db: Database.Database | null = null;

export function openDatabase(dbPath: string): Database.Database {
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('synchronous = NORMAL');

  instance.exec(SCHEMA_SQL);

  const versionRow = instance
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined;
  // No row means this file was just created by the instance.exec(SCHEMA_SQL)
  // call above -- schema.ts always describes the *current* shape, so a
  // brand-new database is already at CURRENT_SCHEMA_VERSION and needs no
  // migrations replayed (replaying them would re-apply changes, like an
  // ALTER TABLE ADD COLUMN, against columns SCHEMA_SQL already created).
  // Only a real existing install -- which always has this row, written
  // unconditionally below on every previous open -- reports a version
  // less than current.
  const currentVersion = versionRow ? Number(versionRow.value) : CURRENT_SCHEMA_VERSION;

  const finalVersion = runMigrations(instance, currentVersion, CURRENT_SCHEMA_VERSION);

  instance
    .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(finalVersion));

  logger.info('database.opened', { schemaVersion: finalVersion });
  db = instance;
  return instance;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized yet');
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}
