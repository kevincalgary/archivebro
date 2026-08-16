import type Database from 'better-sqlite3';
import { logger } from '../util/logger';

type Migration = { version: number; up: (db: Database.Database) => void };

// schema.ts always describes the *current* shape for a fresh install.
// Migrations here only need to cover the delta for existing installs
// upgrading from an older schema_version. There are none yet since this is
// schema v1; this is the seam future changes plug into, e.g.:
//
// const migrations: Migration[] = [
//   { version: 2, up(db) { db.exec('ALTER TABLE archives ADD COLUMN foo TEXT'); } },
// ];
const migrations: Migration[] = [];

export function runMigrations(db: Database.Database, from: number, to: number): number {
  if (from >= to) return from;
  const pending = migrations.filter((m) => m.version > from && m.version <= to).sort((a, b) => a.version - b.version);
  const txn = db.transaction(() => {
    for (const m of pending) {
      logger.info('database.migrating', { toVersion: m.version });
      m.up(db);
    }
  });
  txn();
  return to;
}
