#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cf-bbs v10 ローカルE2Eテスト実行スクリプト
#   1) ローカルD1へマイグレーション（0006含む）を適用
#   2) テスト用設定をシード（Turnstile無効・投稿間隔0・fakeサーバー3台）
#   3) 管理者を作成（create-admin.mjs --local）
#   4) wrangler dev を起動して test-v10.mjs を実行
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."

PORT=8817
BASE="http://127.0.0.1:8817"

echo "=== 0) ローカルD1の事前準備 ==="
npx wrangler d1 migrations apply DB_MAIN --local >/dev/null 2>&1
npx wrangler d1 execute DB_MAIN --local -y --command \
  "INSERT INTO admin_settings (key, value, updated_at) VALUES
     ('require_turnstile_on_auth','false',1),
     ('min_interval_new_sec','0',1),
     ('min_interval_regular_sec','0',1),
     ('record_registration_ip','0',1),
     ('server_auto_removal_days','3',1)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value;
   INSERT OR IGNORE INTO known_servers (url, name, type, added_at, last_synced_at, health, dead_days) VALUES
     ('https://fake-a.example.com','FA','normal',1,1,'down',2),
     ('https://fake-b.example.com','FB','normal',2,1,'down',1),
     ('https://fake-c.example.com','FC','normal',3,1,'up',0);" \
  >/dev/null 2>&1
node scripts/create-admin.mjs --local --email v10-admin@test.local \
  --password 'admin-pass-123' --username '管理' --pepper test-pepper >/dev/null 2>&1
echo "done"

echo "=== 1) wrangler dev 起動 ==="
WRANGLER_SEND_METRICS=false npx wrangler dev --port $PORT \
  --var ENVIRONMENT:development \
  --var PASSWORD_PEPPER:test-pepper \
  --var SESSION_HMAC_SECRET:test-hmac-secret \
  --var CSRF_HMAC_SECRET:test-csrf-secret \
  --var SYNC_SECRET:test-sync-secret-local \
  --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA \
  > /tmp/wrangler-dev-v10.log 2>&1 &
DEV_PID=$!

ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public-config" 2>/dev/null)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ $ready -eq 1 ]; then echo "  ✔ wrangler dev 起動"; else
  echo "  ✘ wrangler dev 起動タイムアウト"; tail -30 /tmp/wrangler-dev-v10.log; kill $DEV_PID 2>/dev/null; exit 1; fi

cleanup() {
  kill $DEV_PID 2>/dev/null
  # npxラッパーのkillでは孫プロセス（wrangler→workerd）が残ってポートを掴み続け、
  # 次回起動時に既存のdevへ繋がってしまうため、ポート指定で確実に掃除する
  pkill -f "wrangler dev --port $PORT" 2>/dev/null
  pkill -f "workerd serve.*:$PORT" 2>/dev/null
  true
}
trap cleanup EXIT

echo "=== 2) test-v10.mjs 実行 ==="
node scripts/test-v10.mjs
STATUS=$?
exit $STATUS
