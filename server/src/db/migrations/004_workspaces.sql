-- Phase 3: update feeds.
CREATE TABLE feed_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('rss','atom','github','page')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_error TEXT,
  page_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE feed_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  UNIQUE(source_id, guid)
);
CREATE INDEX feed_items_unseen ON feed_items(seen, published_at);
