-- ユーザー名変更の制限方式を「クールダウン（時間ベース）」から
-- 「1日あたりの回数制限（既定5回/日）」へ変更するマイグレーション。
-- 成功した変更のみを UTC 日付ごとにカウントする（失敗・未確定の試行は数えない）。

-- 1日あたりの変更回数カウンタ（user_login_days と同じUTC日付キー方式）。
CREATE TABLE IF NOT EXISTS username_change_counts (
  user_id TEXT NOT NULL,
  change_date TEXT NOT NULL, -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, change_date)
);

-- 旧方式（クールダウン時間）の設定値は使用しなくなるため削除し、
-- 新方式の既定値（1日5回まで）を登録する。
DELETE FROM admin_settings WHERE key = 'username_change_cooldown_hours';
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('username_daily_change_limit', '5', unixepoch());
