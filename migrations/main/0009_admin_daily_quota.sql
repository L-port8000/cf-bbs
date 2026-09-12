-- 追加機能: 管理画面の「サーバー レスポンスチェック」ボタン（v11.2）用の
-- 1日あたりの使用回数カウンタ。
--
-- 管理者が手動でサーバーの生存確認（GET /api/health）を実行できる機能で、
-- 外部へのサブリクエスト浪費・連打による悪用を防ぐため管理者ごとに
-- 1日10回まで（日本時間0時にリセット）に制限する。
--
--   user_id = 実行した管理者
--   action  = 制限の種類（現在は 'server_response_check' のみ。将来の
--             管理者向け回数制限を同じ表に追加できるようにしている）
--   day     = 日本時間(JST, UTC+9)の日付 'YYYY-MM-DD'
--   used    = その日の使用回数
--
-- 行は1日1行ずつ増えるだけ（1行あたり数十バイト）で、掃除は不要。
-- サーバー追加時の自動レスポンス確認（addServerCore）はこのカウンタの
-- 対象外（追加操作自体が既に管理者権限+実在確認付きのため）。
CREATE TABLE IF NOT EXISTS admin_daily_quotas (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, action, day)
);
