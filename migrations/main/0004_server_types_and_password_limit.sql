-- 追加機能: サーバー種別（匿名サーバー/通常サーバーの将来拡張の基盤）と
-- パスワード最大文字数の設定。

-- known_servers にサーバー種別を追加。
-- 'normal'  = アカウント登録が必要な通常サーバー（現状の全サーバーがこれ）
-- 'anonymous' = 将来追加予定の匿名サーバー用（今はまだUI上の区別のみ）
-- 既存行はすべて 'normal' として扱う。
ALTER TABLE known_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'normal';

-- パスワードの最大文字数（ユーザー名と同じく20文字に制限する）。
-- 新規登録時のみ強制（既存パスワードが20文字を超えるユーザーを締め出さないため、
-- ログイン時には最大長チェックをしない）。
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('password_max_len', '20', unixepoch());
