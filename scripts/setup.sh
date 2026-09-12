#!/usr/bin/env bash
# cf-bbs の新しいサーバー（＝別Cloudflareアカウントでの新規デプロイ）を
# ワンコマンドでセットアップするスクリプト。
#
# 手動で行うと最低9箇所（D1×3・KV×1のID転記、wrangler.tomlの各種書き換え、
# シークレット6個の設定）が必要な作業を自動化する。
#
# 使い方:
#   npx wrangler login   # 先にこのアカウントでログインしておく
#   bash scripts/setup.sh <slug> "<表示名>" [BOOTSTRAP_ADMIN_EMAIL] [PRIMARY_API_DOMAIN]
#
# 例:
#   bash scripts/setup.sh server2 "サーバー2" you@example.com
#
# slug は D1/KVリソース名の重複を避けるための短い識別子（英数字推奨）。
# 同じCloudflareアカウント内で複数回このスクリプトを実行する場合は
# 毎回違うslugを使うこと（別アカウントであれば同じslugでも問題ない）。
#
# 【このスクリプトが自動化すること】
#   - D1データベースを3つ作成し、wrangler.tomlへID・名前を反映
#   - KV Namespaceを1つ作成し、wrangler.tomlへID を反映
#   - マイグレーションを本番D1へ適用
#   - PASSWORD_PEPPER等5つのシークレットをランダム生成して設定
#   - TURNSTILE_SECRET_KEYをCloudflare公式テストキーで暫定設定
#   - SERVER_DISPLAY_NAME / BOOTSTRAP_ADMIN_EMAIL / PRIMARY_API_DOMAIN(任意)の反映
#
# 【このスクリプトが自動化しないこと（手動対応が必要）】
#   - Turnstileの本番用サイトキー/シークレットキーへの差し替え
#   - Custom Domainの割り当て
#   - npx wrangler deploy の実行（最後に案内するので手動で実行すること）

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "使い方: $0 <slug> \"<表示名>\" [BOOTSTRAP_ADMIN_EMAIL] [PRIMARY_API_DOMAIN]" >&2
  echo "例:     $0 server2 \"サーバー2\" you@example.com" >&2
  exit 1
fi

SLUG="$1"
DISPLAY_NAME="$2"
BOOTSTRAP_EMAIL="${3:-}"
PRIMARY_DOMAIN="${4:-}"
TOML="wrangler.toml"

if [ ! -f "$TOML" ]; then
  echo "wrangler.tomlが見つかりません。プロジェクトのルートディレクトリで実行してください。" >&2
  exit 1
fi
if ! [[ "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "slugは英小文字・数字・ハイフンのみで指定してください（例: server2）" >&2
  exit 1
fi

echo "== Wrangler ログイン状態を確認 =="
WHOAMI_OUT=$(npx wrangler whoami)
echo "$WHOAMI_OUT"

extract_id() {
  sed -nE 's/.*"([a-f0-9-]{8,})".*/\1/p' | head -1
}

echo ""
echo "== D1データベースを3つ作成 =="
DB_MAIN_OUT=$(npx wrangler d1 create "cf-bbs-${SLUG}-main")
echo "$DB_MAIN_OUT"
DB_MAIN_ID=$(echo "$DB_MAIN_OUT" | grep 'database_id' | extract_id)

DB_SHARD1_OUT=$(npx wrangler d1 create "cf-bbs-${SLUG}-shard1")
echo "$DB_SHARD1_OUT"
DB_SHARD1_ID=$(echo "$DB_SHARD1_OUT" | grep 'database_id' | extract_id)

DB_SHARD2_OUT=$(npx wrangler d1 create "cf-bbs-${SLUG}-shard2")
echo "$DB_SHARD2_OUT"
DB_SHARD2_ID=$(echo "$DB_SHARD2_OUT" | grep 'database_id' | extract_id)

if [ -z "$DB_MAIN_ID" ] || [ -z "$DB_SHARD1_ID" ] || [ -z "$DB_SHARD2_ID" ]; then
  echo "D1データベースIDの取得に失敗しました。上の出力を確認し、wrangler.tomlを手動で編集してください。" >&2
  exit 1
fi

echo ""
echo "== KV Namespace を作成 =="
KV_OUT=$(npx wrangler kv namespace create "SESSIONS_KV_${SLUG}")
echo "$KV_OUT"
KV_ID=$(echo "$KV_OUT" | grep -E '^id = ' | extract_id)

if [ -z "$KV_ID" ]; then
  echo "KV Namespace IDの取得に失敗しました。上の出力を確認し、wrangler.tomlを手動で編集してください。" >&2
  exit 1
fi

echo ""
echo "== wrangler.toml を書き換え =="
cp "$TOML" "${TOML}.bak"
echo "（変更前を ${TOML}.bak に退避しました）"

sed -i "s/REPLACE-WITH-DB-MAIN-ID/${DB_MAIN_ID}/g" "$TOML"
sed -i "s/REPLACE-WITH-DB-SHARD1-ID/${DB_SHARD1_ID}/g" "$TOML"
sed -i "s/REPLACE-WITH-DB-SHARD2-ID/${DB_SHARD2_ID}/g" "$TOML"
sed -i "s/REPLACE-WITH-KV-NAMESPACE-ID/${KV_ID}/g" "$TOML"
sed -i "s/database_name = \"cf-bbs-main\"/database_name = \"cf-bbs-${SLUG}-main\"/" "$TOML"
sed -i "s/database_name = \"cf-bbs-shard1\"/database_name = \"cf-bbs-${SLUG}-shard1\"/" "$TOML"
sed -i "s/database_name = \"cf-bbs-shard2\"/database_name = \"cf-bbs-${SLUG}-shard2\"/" "$TOML"
sed -i "s/SERVER_DISPLAY_NAME = \"サーバー1\"/SERVER_DISPLAY_NAME = \"${DISPLAY_NAME}\"/" "$TOML"

if [ -n "$BOOTSTRAP_EMAIL" ]; then
  sed -i "s/BOOTSTRAP_ADMIN_EMAIL = \"\"/BOOTSTRAP_ADMIN_EMAIL = \"${BOOTSTRAP_EMAIL}\"/" "$TOML"
fi
if [ -n "$PRIMARY_DOMAIN" ]; then
  sed -i "s/PRIMARY_API_DOMAIN = \"bbs.example.com\"/PRIMARY_API_DOMAIN = \"${PRIMARY_DOMAIN}\"/" "$TOML"
fi

# /status機能用のCF_ACCOUNT_ID（32桁の16進）をwhoami出力から自動取得して設定。
# 取得できない場合は空文字のまま（手動設定はREADME 15章参照）。
ACCOUNT_ID=$(echo "$WHOAMI_OUT" | grep -oE '[a-f0-9]{32}' | head -1 || true)
if [ -n "$ACCOUNT_ID" ]; then
  sed -i "s/^CF_ACCOUNT_ID = \"\"/CF_ACCOUNT_ID = \"${ACCOUNT_ID}\"/" "$TOML"
  echo "（/status用に CF_ACCOUNT_ID = ${ACCOUNT_ID} を設定しました）"
fi

# 置換漏れチェック: プレースホルダーが残っていたらID転記に失敗しているので
# ここで確実に異常終了する（静かに壊れて古いDB/他人のDBを見に行くのを防ぐ）。
# ※ KVブロックを削除してKV無し構成にした場合はKVのプレースホルダーは存在しないのが正常。
if grep -q 'REPLACE-WITH-' "$TOML"; then
  echo "" >&2
  echo "エラー: wrangler.toml に未割当のプレースホルダー(REPLACE-WITH-*)が残っています:" >&2
  grep -n 'REPLACE-WITH-' "$TOML" >&2
  echo "上の箇所を実際のIDに置き換えてから再実行してください。" >&2
  exit 1
fi

echo ""
echo "== 依存関係をインストール =="
npm install --no-audit --no-fund

echo ""
echo "== マイグレーションを本番D1へ適用 =="
npm run db:migrate:remote
npm run db:migrate:shard1:remote
npm run db:migrate:shard2:remote

gen_secret() {
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
}

echo ""
echo "== シークレットを生成して設定 =="
gen_secret | npx wrangler secret put PASSWORD_PEPPER
gen_secret | npx wrangler secret put SESSION_HMAC_SECRET
gen_secret | npx wrangler secret put CSRF_HMAC_SECRET
gen_secret | npx wrangler secret put SYNC_SECRET
gen_secret | npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
echo "1x0000000000000000000000000000000AA" | npx wrangler secret put TURNSTILE_SECRET_KEY

cat <<SUMMARY

====================================================
セットアップが完了しました。

  DB_MAIN_ID   = ${DB_MAIN_ID}
  DB_SHARD1_ID = ${DB_SHARD1_ID}
  DB_SHARD2_ID = ${DB_SHARD2_ID}
  KV_ID        = ${KV_ID}

【重要】TURNSTILE_SECRET_KEY は Cloudflare公式のテスト用キー（常に成功する
ダミー）のまま設定されています。本番運用する前に、Turnstileダッシュボードで
実際のウィジェットを作成し、以下を実行してください:
  1. wrangler.toml の TURNSTILE_SITE_KEY を実際のSite Keyに書き換える
  2. echo "実際のSecret Key" | npx wrangler secret put TURNSTILE_SECRET_KEY

残りの手動作業:
  - Custom Domainを使う場合はCloudflareダッシュボードで割り当ててから、
    wrangler.toml の PRIMARY_API_DOMAIN を実URLに書き換える
    （*.workers.dev のURLのままで良ければ不要）
  - 最後に以下でデプロイする:
      npx wrangler deploy
  - デプロイ後、既存サーバーの管理画面「サーバー管理」タブから
    このサーバーのURLを追加すると、両方のサーバーが選択画面に表示される
====================================================
SUMMARY
