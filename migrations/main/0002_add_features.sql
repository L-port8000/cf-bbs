-- 追加機能: ユーザー名、サーバー一覧（複数Workers選択機能）、関連設定
-- 既に0001が本番適用済みであることを前提とした追加マイグレーション。

-- ユーザー名（任意。未設定の場合は投稿時に「名無しさん」として扱う）
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- スレッド・投稿に表示名を非正規化して保存する。
-- 理由: posts/threadsはシャードごとに別D1へ分散されるため、usersテーブル
-- (DB_MAINのみに存在)とのJOINができない。投稿時点の表示名をそのまま
-- 保存することで、どのD1に対しても追加JOIN無しで表示名を返せるようにする
-- （ユーザーが後から改名しても過去の投稿の表示名は変わらない仕様）。
ALTER TABLE threads ADD COLUMN username TEXT NOT NULL DEFAULT '名無しさん';
ALTER TABLE posts ADD COLUMN username TEXT NOT NULL DEFAULT '名無しさん';

-- 複数サーバー（Workers）選択機能: 既知サーバーの一覧。
-- 「同じ内容が表示できなくても良い」前提で、各サーバーが独立したBBSとして
-- 動作しつつ、どのサーバーが存在するかの一覧だけを緩やかに共有する。
CREATE TABLE IF NOT EXISTS known_servers (
  url TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_synced_at INTEGER
);

-- ユーザー名機能の追加設定（ハードコード禁止方針を踏襲）
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('username_min_len', '1', unixepoch()),
  ('username_max_len', '20', unixepoch()),
  ('username_change_cooldown_hours', '24', unixepoch());
