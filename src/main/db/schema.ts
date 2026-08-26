// Schema version 1. See migrations.ts for how this evolves over time.
// Kept as a TS string (rather than a sibling .sql file) so it ships
// correctly in the compiled dist/ output without a separate copy step.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,               -- UUID
  canonical_url TEXT NOT NULL,       -- URL with hash stripped, used to group versions
  original_url TEXT NOT NULL,        -- URL as first requested
  final_url TEXT NOT NULL,           -- URL after redirects
  title TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL,
  favicon_path TEXT,
  referrer_url TEXT,
  captured_at TEXT NOT NULL,         -- ISO8601, when files were written
  visited_at TEXT NOT NULL,          -- ISO8601, when navigation happened
  status TEXT NOT NULL,              -- success | failed | skipped-*
  warnings_json TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  app_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  has_mhtml INTEGER NOT NULL DEFAULT 0,
  has_screenshot INTEGER NOT NULL DEFAULT 0,
  has_text INTEGER NOT NULL DEFAULT 0,
  mhtml_sha256 TEXT,                 -- content hash at capture time; null for archives predating this column
  screenshot_sha256 TEXT,
  text_sha256 TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_archives_canonical_url ON archives(canonical_url);
CREATE INDEX IF NOT EXISTS idx_archives_domain ON archives(domain);
CREATE INDEX IF NOT EXISTS idx_archives_captured_at ON archives(captured_at);
CREATE INDEX IF NOT EXISTS idx_archives_status ON archives(status);
CREATE INDEX IF NOT EXISTS idx_archives_deleted ON archives(deleted);

-- FTS5 index over title + url + domain + extracted text. Rows are managed
-- explicitly by ArchiveRepo (insert on capture, update once text
-- extraction finishes, delete on archive delete) rather than by triggers,
-- since text extraction completes asynchronously after the initial row is
-- inserted.
CREATE VIRTUAL TABLE IF NOT EXISTS archives_fts USING fts5(
  archive_id UNINDEXED,
  title,
  url,
  domain,
  body
);

CREATE TABLE IF NOT EXISTS interrupted_captures (
  archive_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);

-- Persistent, app-wide registry of completed .sitearchive captures --
-- separate from the "archives" table above, which is schema-locked to
-- single-page auto-captures (has_mhtml/screenshot/text, one page per row).
-- A .sitearchive is a portable multi-page file; this table is just an
-- index of paths + summary stats for the history screen, not a copy of
-- the archive's own content -- see siteArchiveHistoryRepo.ts.
CREATE TABLE IF NOT EXISTS site_archive_captures (
  archive_id TEXT PRIMARY KEY,
  output_path TEXT NOT NULL,
  site_title TEXT NOT NULL,
  start_url TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  asset_count INTEGER NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  thread_count INTEGER,
  section_count INTEGER,
  attachment_count INTEGER,
  is_complete INTEGER NOT NULL,
  incomplete_reason TEXT,
  failure_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_archive_captures_captured_at ON site_archive_captures(captured_at);
`;
