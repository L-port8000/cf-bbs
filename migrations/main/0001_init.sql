-- cf-bbs / DB_MAIN 初期スキーマ
-- users, login履歴, threads, posts, archive_manifest, admin設定, 監査ログ

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  tier TEXT NOT NULL DEFAULT 'new',       -- 'new' | 'regular'
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'banned'
  ban_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 「異なる3日間のログイン」で新規ユーザーを通常ユーザーへ昇格させるための履歴。
-- 同一日の複数ログインは1行のみ（PRIMARY KEYで重複を防止）。
CREATE TABLE IF NOT EXISTS user_login_days (
  user_id TEXT NOT NULL,
  login_date TEXT NOT NULL, -- 'YYYY-MM-DD' (UTC)
  PRIMARY KEY (user_id, login_date)
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible', -- 'visible' | 'hidden' | 'deleted'
  origin TEXT NOT NULL DEFAULT 'primary'  -- 'primary' | 'backup'（Primary/Backup構成用）
);

CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);

CREATE TABLE IF NOT EXISTS posts (
  post_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  status TEXT NOT NULL DEFAULT 'visible', -- 'visible' | 'hidden' | 'deleted'
  origin TEXT NOT NULL DEFAULT 'primary'  -- 'primary' | 'backup'
);

CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);

-- どのスレッドがどのD1に存在するかを管理するマニフェスト（R2は使用しない）。
-- 行が無いスレッドは DB_MAIN (= 'main') に存在するものとして扱う。
-- 保持期間(data_retention_days)を超えて削除されたスレッドは行ごと削除される。
CREATE TABLE IF NOT EXISTS archive_manifest (
  thread_id INTEGER PRIMARY KEY,
  shard TEXT NOT NULL,       -- 'main' | 'shard1' | 'shard2'
  post_count INTEGER NOT NULL DEFAULT 0,
  migrated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_manifest_shard ON archive_manifest(shard);

-- ハードコード禁止項目（Daily Limit / 投稿間隔 / 最大文字数 等）を保持する設定テーブル。
-- 読み取りはWorker内でKVへ短時間キャッシュしD1 Readを削減する。
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);

-- 初期設定値
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('daily_limit_new', '50', unixepoch()),
  ('daily_limit_regular', '300', unixepoch()),
  ('min_interval_new_sec', '30', unixepoch()),
  ('min_interval_regular_sec', '5', unixepoch()),
  ('max_body_len', '200', unixepoch()),
  ('max_urls', '5', unixepoch()),
  ('promotion_distinct_days', '3', unixepoch()),
  ('require_turnstile_on_post', 'false', unixepoch()),
  ('require_turnstile_on_auth', 'true', unixepoch()),
  ('data_retention_days', '730', unixepoch());
