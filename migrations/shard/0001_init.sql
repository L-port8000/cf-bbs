-- cf-bbs / DB_SHARD_1, DB_SHARD_2 共通スキーマ
-- Mainからスレッド単位で移行されてきた古い投稿を保持する。
-- スキーマはDB_MAINのthreads/postsと同一（マニフェストは常にDB_MAIN側で一元管理）。

CREATE TABLE IF NOT EXISTS threads (
  thread_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  origin TEXT NOT NULL DEFAULT 'primary'
);

CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  post_id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  status TEXT NOT NULL DEFAULT 'visible',
  origin TEXT NOT NULL DEFAULT 'primary'
);

CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, created_at);
