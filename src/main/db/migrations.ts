import type Database from 'better-sqlite3';
import { logger } from '../util/logger';

type Migration = { version: number; up: (db: Database.Database) => void };

// schema.ts always describes the *current* shape for a fresh install.
// Migrations here only need to cover the delta for existing installs
// upgrading from an older schema_version.
const migrations: Migration[] = [
  {
    version: 2,
    up(db) {
      // Per-page capture integrity hashes (roadmap: "Archive integrity
      // hashing"). Existing rows get NULL, which readers treat the same
      // way the .sitearchive reader treats a missing manifest hash: no
      // recorded hash means nothing to verify, not a mismatch.
      db.exec(`
        ALTER TABLE archives ADD COLUMN mhtml_sha256 TEXT;
        ALTER TABLE archives ADD COLUMN screenshot_sha256 TEXT;
        ALTER TABLE archives ADD COLUMN text_sha256 TEXT;
      `);
    },
  },
];

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
