#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Turnstile修正のローカルE2Eテスト（v6）
#   - public-config に turnstileOnAuth / turnstileOnPost フラグが乗ること
#   - 登録: トークンあり→成功 / トークン無し→400+理由別メッセージ
#   - ログイン: 同上
#   - require_turnstile_on_post の強制（従来は設定が効いていなかった）
#     ・オフ時はトークン無しでも投稿できる（既定動作を維持）
#     ・オン時はトークン無し→400 / トークンあり→201
#   Cloudflareテスト用シークレット（常に成功）を使用するため実ネットワーク
#   （challenges.cloudflare.com）が必要。
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."

BASE="http://127.0.0.1:8807"
PORT=8807
PASS=0; FAIL=0

ok()  { echo "  ✔ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✘ $1"; FAIL=$((FAIL+1)); }

echo "=== 0) ローカルD1の事前準備 ==="
npx wrangler d1 execute DB_MAIN --local -y --command \
  "DELETE FROM users WHERE email LIKE 'ts-fix-%@test.local'; \
   INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_auth','true',1) ON CONFLICT(key) DO UPDATE SET value='true'; \
   INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_post','false',1) ON CONFLICT(key) DO UPDATE SET value='false'; \
   INSERT INTO admin_settings (key, value, updated_at) VALUES ('min_interval_new_sec','0',1) ON CONFLICT(key) DO UPDATE SET value='0'; \
   INSERT INTO admin_settings (key, value, updated_at) VALUES ('min_interval_regular_sec','0',1) ON CONFLICT(key) DO UPDATE SET value='0';" \
  >/dev/null 2>&1
echo "done"

echo "=== 1) wrangler dev 起動（テスト用シークレット: 常に成功） ==="
WRANGLER_SEND_METRICS=false npx wrangler dev --port $PORT \
  --var ENVIRONMENT:development \
  --var PASSWORD_PEPPER:test-pepper \
  --var SESSION_HMAC_SECRET:test-hmac-secret \
  --var CSRF_HMAC_SECRET:test-csrf-secret \
  --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA \
  > /tmp/wrangler-dev-v6.log 2>&1 &
DEV_PID=$!
ready=0
for i in $(seq 1 60); do
  code=$(curl -s -H "Origin: $BASE" -o /dev/null -w '%{http_code}' "$BASE/api/public-config" 2>/dev/null)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ $ready -eq 1 ]; then ok "wrangler dev 起動"; else bad "wrangler dev 起動タイムアウト"; tail -30 /tmp/wrangler-dev-v6.log; kill $DEV_PID 2>/dev/null; exit 1; fi

cleanup() {
  kill $DEV_PID 2>/dev/null
  # npxラッパーのkillでは孫プロセス（wrangler→workerd）が残るためポート指定でも掃除
  pkill -f "wrangler dev --port $PORT" 2>/dev/null
  pkill -f "workerd serve.*:$PORT" 2>/dev/null
  true
}
trap cleanup EXIT

echo "=== 2) public-config にTurnstileフラグが乗っているか ==="
CFG=$(curl -s -H "Origin: $BASE" "$BASE/api/public-config")
echo "$CFG" | grep -q '"turnstileOnAuth":true'  && ok "turnstileOnAuth=true"  || bad "turnstileOnAuth ($CFG)"
echo "$CFG" | grep -q '"turnstileOnPost":false' && ok "turnstileOnPost=false" || bad "turnstileOnPost"

EMAIL_A="ts-fix-$(date +%s)@test.local"
EMAIL_B="ts-fix-b-$(date +%s)@test.local"

echo "=== 3) 登録（トークンあり→成功） ==="
code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-reg-a.json -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"TS検証\",\"email\":\"$EMAIL_A\",\"password\":\"pass1234\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}")
if [ "$code" = "200" ]; then ok "登録成功 ($code)"; else bad "登録が失敗 ($code)"; cat /tmp/ts-reg-a.json; fi

echo "=== 4) 登録（トークン無し→400+理由メッセージ） ==="
body=$(curl -s -H "Origin: $BASE" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\":\"TS検証2\",\"email\":\"$EMAIL_B\",\"password\":\"pass1234\"}")
echo "$body" | grep -q '"code":"turnstile_failed"' && ok "turnstile_failed" || bad "code ($body)"
echo "$body" | grep -q "取得できませんでした" && ok "missing-input用メッセージ" || bad "message ($body)"

echo "=== 5) ログイン（トークンあり→成功 / 無し→400） ==="
code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-login.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"pass1234\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}")
if [ "$code" = "200" ]; then ok "ログイン成功 ($code)"; else bad "ログイン失敗 ($code)"; cat /tmp/ts-login.json; fi
CSRF=$(python3 -c "import json;print(json.load(open('/tmp/ts-login.json'))['csrfToken'])" 2>/dev/null)
[ -n "${CSRF:-}" ] && ok "CSRF取得" || bad "CSRF取得失敗"

body=$(curl -s -H "Origin: $BASE" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"pass1234\"}")
echo "$body" | grep -q '"code":"turnstile_failed"' && ok "ログインもトークン無しは400" || bad "login code ($body)"

echo "=== 6) 投稿時Turnstileがオフ: トークン無しでも投稿できる（既定動作維持） ==="
code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-thread1.json -w '%{http_code}' -X POST "$BASE/api/threads" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -b /tmp/ts-cookie.txt \
  -d "{\"title\":\"TS修正テスト\",\"body\":\"トークン無しで投稿できるかの確認\"}")
# ログイン時のCookieを保存していないので、まずcookie付きで再ログイン
curl -s -H "Origin: $BASE" -c /tmp/ts-cookie.txt -o /dev/null -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"pass1234\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}"
CSRF2=$(curl -s -H "Origin: $BASE" -c /tmp/ts-cookie.txt -b /tmp/ts-cookie.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"pass1234\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-thread1.json -w '%{http_code}' -X POST "$BASE/api/threads" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF2" \
  -b /tmp/ts-cookie.txt \
  -d "{\"title\":\"TS修正テスト\",\"body\":\"トークン無しで投稿できるかの確認\"}")
if [ "$code" = "201" ]; then ok "トークン無しスレッド作成OK ($code)"; else bad "スレッド作成が失敗 ($code)"; cat /tmp/ts-thread1.json; fi
THREAD_ID=$(python3 -c "import json;print(json.load(open('/tmp/ts-thread1.json'))['thread_id'])" 2>/dev/null)

echo "=== 7) 投稿時Turnstileをオン: トークン無し→400 / あり→201 ==="
npx wrangler d1 execute DB_MAIN --local -y --command \
  "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_post','true',2) ON CONFLICT(key) DO UPDATE SET value='true'" >/dev/null 2>&1
sleep 31 # 設定はIsolate内メモリに30秒キャッシュされるため待つ

body=$(curl -s -H "Origin: $BASE" -X POST "$BASE/api/threads" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF2" \
  -b /tmp/ts-cookie.txt \
  -d "{\"title\":\"TSオン\",\"body\":\"トークン無しは拒否されるべき\"}")
echo "$body" | grep -q '"code":"turnstile_failed"' && ok "投稿もトークン無しは400" || bad "post code ($body)"

code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-thread2.json -w '%{http_code}' -X POST "$BASE/api/threads" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF2" \
  -b /tmp/ts-cookie.txt \
  -d "{\"title\":\"TSオン\",\"body\":\"トークンありなら成功\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}")
if [ "$code" = "201" ]; then ok "トークンありスレッド作成OK ($code)"; else bad "スレッド作成失敗 ($code)"; cat /tmp/ts-thread2.json; fi
THREAD2=$(python3 -c "import json;print(json.load(open('/tmp/ts-thread2.json'))['thread_id'])" 2>/dev/null)

code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-reply.json -w '%{http_code}' -X POST "$BASE/api/threads/$THREAD2/posts" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF2" \
  -b /tmp/ts-cookie.txt \
  -d "{\"body\":\"トークンあり返信\",\"turnstileToken\":\"DUMMY.TOKEN.test\"}")
if [ "$code" = "201" ]; then ok "トークンあり返信OK ($code)"; else bad "返信失敗 ($code)"; cat /tmp/ts-reply.json; fi

echo "=== 8) 投稿時Turnstileを戻す: トークン無し返信が再び通る ==="
npx wrangler d1 execute DB_MAIN --local -y --command \
  "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_post','false',3) ON CONFLICT(key) DO UPDATE SET value='false'" >/dev/null 2>&1
sleep 31
code=$(curl -s -H "Origin: $BASE" -o /tmp/ts-reply2.json -w '%{http_code}' -X POST "$BASE/api/threads/$THREAD_ID/posts" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF2" \
  -b /tmp/ts-cookie.txt \
  -d "{\"body\":\"トークン無し返信（オフに戻した）\"}")
if [ "$code" = "201" ]; then ok "オフに戻すとトークン無し返信OK ($code)"; else bad "返信失敗 ($code)"; cat /tmp/ts-reply2.json; fi

echo ""
echo "=== 結果: $PASS passed / $FAIL failed ==="
[ $FAIL -eq 0 ]
