#!/usr/bin/env bash
# 回帰テスト: test-v8-jwt-cluster + test-v8-hmac-admin + test-v9-account
# （Cache APIの15秒キャッシュがテスト間で干渉しないよう、v9は別のdevインスタンスで実行する）
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:8787"

start_dev() {
  WRANGLER_SEND_METRICS=false npx wrangler dev --port $PORT \
    --var ENVIRONMENT:development \
    --var PASSWORD_PEPPER:test-pepper \
    --var SESSION_HMAC_SECRET:test-hmac-secret \
    --var CSRF_HMAC_SECRET:test-csrf-secret \
    --var SYNC_SECRET:test-sync-secret-local \
    --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA \
    > "$1" 2>&1 &
  DEV_PID=$!
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public-config" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 1
  done
  echo "dev ready ($1)"
}
stop_dev() {
  kill $DEV_PID 2>/dev/null; wait $DEV_PID 2>/dev/null
  # npxラッパーのkillでは孫プロセス（wrangler→workerd）が残るためポート指定でも掃除
  pkill -f "wrangler dev --port $PORT" 2>/dev/null
  pkill -f "workerd serve.*:$PORT" 2>/dev/null
  sleep 1
}

# 退会テスト（v9）の匿名化は全D1（シャード含む）へUPDATEするため、
# シャード2台にもスキーマが必要（本番と同じ構成でローカル準備する）
npx wrangler d1 migrations apply DB_MAIN --local >/dev/null 2>&1
npx wrangler d1 migrations apply DB_SHARD_1 --local >/dev/null 2>&1
npx wrangler d1 migrations apply DB_SHARD_2 --local >/dev/null 2>&1
npx wrangler d1 execute DB_MAIN --local -y --command \
  "DELETE FROM known_servers;
   INSERT INTO admin_settings (key, value, updated_at) VALUES
     ('require_turnstile_on_auth','false',1),
     ('require_turnstile_on_post','false',1),
     ('min_interval_new_sec','0',1),
     ('min_interval_regular_sec','0',1),
     ('auth_mode','jwt',1)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value;" \
  >/dev/null 2>&1
node scripts/create-admin.mjs --local --email v8-admin@test.local \
  --password 'adminpass123' --username 'v8管理' --pepper test-pepper >/dev/null 2>&1
node scripts/create-admin.mjs --local --email v9-admin@test.local \
  --password 'admin-pass-123' --username 'v9管理' --pepper test-pepper >/dev/null 2>&1
node scripts/create-admin.mjs --local --email v11-admin@test.local \
  --password 'v11-admin-pass' --username 'v11管理' --pepper test-pepper >/dev/null 2>&1

echo "=== dev #1: v8テスト群 ==="
start_dev /tmp/wrangler-dev-regression.log
node scripts/test-v8-jwt-cluster.mjs
S1=$?
ADMIN_EMAIL=v8-admin@test.local node scripts/test-v8-hmac-admin.mjs
S2=$?
stop_dev

echo "=== dev #2: v9（キャッシュ回避のためインスタンスを新規にする） ==="
start_dev /tmp/wrangler-dev-regression2.log
node scripts/test-v9-account.mjs
S3=$?
stop_dev

# v11はv9と同じインスタンスで実行しない（v9のネガティブテスト群が
# AuthGuard=IP単位15分窓の失敗カウンタを消費し、v11の登録が429になるため）。
# さらにAuthGuardの状態はCache API（.wrangler/state/v3/cache）に永続化され
# devインスタンスをまたいで残るため、v11の前にキャッシュだけを掃除する
# （D1の実データ .wrangler/state/v3/d1 は触らない）。
rm -rf .wrangler/state/v3/cache
echo "=== dev #3: v11（外部ツール拒否 + APIキー + サーバー手動チェック） ==="
start_dev /tmp/wrangler-dev-regression3.log
node scripts/test-v11-api-keys.mjs
S4=$?
node scripts/test-v11-server-check.mjs
S5=$?
stop_dev

echo "=== results: v8jwt=$S1 v8hmac=$S2 v9=$S3 v11=$S4 check=$S5 ==="
[ $S1 -eq 0 ] && [ $S2 -eq 0 ] && [ $S3 -eq 0 ] && [ $S4 -eq 0 ] && [ $S5 -eq 0 ] || exit 1
