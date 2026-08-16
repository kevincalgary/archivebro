import Database from 'better-sqlite3';
import { logger } from '../util/logger';
import { runMigrations } from './migrations';
import { SCHEMA_SQL } from './schema';

export const CURRENT_SCHEMA_VERSION = 1;

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
  const currentVersion = versionRow ? Number(versionRow.value) : 0;

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
