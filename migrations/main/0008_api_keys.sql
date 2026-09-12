-- v11: APIキー（外部ツール用の正規認証経路）
--
-- 背景: v11から書き込み系APIは requireValidOrigin の厳格化により「ブラウザ発
-- リクエスト（Origin/Refererヘッダあり）」のみ受け付ける（curl等の外部ツールは
-- ヘッダ無しのため既定で403拒否される）。外部ツールからの正規アクセスは、
-- ユーザーが設定画面「高度な機能」で発行したAPIキー
-- （Authorization: Bearer cfbk_... ヘッダ）でのみ許可する。
--
-- 設計:
-- - キー本体は平文保存しない。SHA-256ハッシュ（key_hash・UNIQUE）のみ保存し、
--   照合はハッシュ一致で行う（DB漏えい時にキーを復元できない）
-- - key_prefix は管理表示用の先頭13文字（cfbk_ + 8文字）。全文は発行時に一度だけ返す
-- - key_id は外部識別子（"ak_"接頭辞）。セッションCookie等には使わない
-- - ユーザーあたりの発行本数上限は実装側（MAX_API_KEYS_PER_USER = 10）で制御
-- - 退会時は本人の行を handleDeleteAccount がまとめて削除
-- - BAN・退会は毎リクエストのユーザー行ロードで即時反映（+1 D1 read/リクエスト）
--
-- 対象は DB_MAIN のみ（shard1/shard2 には適用しない）。

CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
