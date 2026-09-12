-- 追加機能（v10）:
--   1. 登録時IPアドレスの保持（管理画面でON/OFF切替・既定OFF・一括消去API付き）
--   2. サーバーの自動削除伝播（日次ヘルスチェックで連続到達不能が続いた
--      サーバーを全サーバーのリストから削除する）
--
-- 詳細はREADME（§14 自動削除伝播 / §22 プライバシー）を参照。

-- 登録時のIPアドレス（CF-Connecting-IP）。record_registration_ip 設定が
-- '1' のときのみ新規登録時に保存する（既定OFFのためNULLのまま）。
-- いつでも管理画面から一括消去できる（POST /api/admin/privacy/purge-registration-ips）。
ALTER TABLE users ADD COLUMN registration_ip TEXT;

-- 連続到達不能日数（日次ヘルスチェックの集約結果）。
--   up票が多数 / 判定材料が不足 → 0にリセット
--   2台以上のチェック担当がdown判定 → +1
--   dead_days >= server_auto_removal_days（既定3・管理画面で1〜7変更可）
--   になったサーバーは全サーバーの既知リストから自動削除される。
ALTER TABLE known_servers ADD COLUMN dead_days INTEGER NOT NULL DEFAULT 0;

-- 新しい管理設定の既定値。
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('record_registration_ip', '0', unixepoch()),   -- 既定OFF（プライバシー優先）
  ('server_auto_removal_days', '3', unixepoch()); -- 連続3日到達不能で自動削除
