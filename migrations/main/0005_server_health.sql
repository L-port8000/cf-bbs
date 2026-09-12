-- 追加機能: サーバー稼働状態の自動監視（日次ヘルスチェック）と、
-- チェック担当サーバー選定のための前日アクセス統計。
--
-- 運用フロー（日本時間・各サーバーのCron Triggerが協調動作）:
--   23:59  各サーバーが自分の当日アクセス数を全既知サーバーへ共有
--          （共有できなかったサーバーは翌0:00のチェック担当から外れる）
--    0:00  前日アクセスが少なかった順に最大3サーバー（総サーバー数が
--          3以下なら全員）が担当となり、全サーバーの生存確認を実施
--    0:01  担当サーバーが結果を全サーバーへ公開（push）。他サーバーは
--          担当サーバーから結果を取得（pull）して自分のDBを更新
--   ※ 新規サーバー登録時は従来どおり即時で全サーバーへ告知（announce）。

-- known_servers に稼働状態を追加。
-- 'up'      = 最新のチェックで生存を確認
-- 'down'    = 最新のチェックで応答なし
-- 'unknown' = まだ一度もチェックされていない
ALTER TABLE known_servers ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE known_servers ADD COLUMN last_health_at INTEGER; -- 最終チェック時刻(ms)
ALTER TABLE known_servers ADD COLUMN last_up_at INTEGER;     -- 最後に生存を確認できた時刻(ms)

-- 各サーバーが日次で共有してくるアクセス統計（チェック担当の選定に使う）。
-- stat_date は日本時間(JST, UTC+9)の日付 'YYYY-MM-DD'。
-- reported_at が NULL の行は「数値未確定」として扱う（現状は発生しないが将来の拡張用）。
CREATE TABLE IF NOT EXISTS server_access_stats (
  server_url TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER,
  PRIMARY KEY (server_url, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_access_stats_date ON server_access_stats(stat_date);

-- HMACセッションモード（管理画面で認証方式を JWT ⇔ HMAC から選択可能）用の
-- サーバー側セッションストア。KVは完全廃止のため、セッション実体はD1へ置く。
--   JWTモード  = この表を使わない（ステートレス・ストレージ消費ゼロ）
--   HMACモード = ログイン時に1行INSERT、認証のたびに1行SELECT、
--                ログアウト/BANで即時DELETE（失効が即時反映される）
CREATE TABLE IF NOT EXISTS d1_sessions (
  session_id TEXT PRIMARY KEY,      -- Cookieに持つランダムID（"sid_" で始まる）
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'user' | 'admin'（ログイン時点の値）
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_d1_sessions_user ON d1_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_d1_sessions_expires ON d1_sessions(expires_at);
