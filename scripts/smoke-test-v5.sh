#!/usr/bin/env bash
# cf-bbs v5 ローカルE2Eテスト: 管理者CLI作成・/status解放・スレッド完全削除・半角制限
set -u
cd "$(dirname "$0")/.."

PORT=8799
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
JQ="jq -r"

ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# ステータスコード付きでリクエスト: rc[path jar method body] -> (body, code)
req() {
  local path="$1" jar="$2" method="${3:-GET}" body="${4:-}"
  local extra=()
  if [ -n "$jar" ] && [ -f "$jar" ]; then
    extra+=(-b "$jar")
    local csrf; csrf=$(awk '$6=="bbs_csrf"{print $7}' "$jar")
    if [ -n "$csrf" ]; then extra+=(-H "X-CSRF-Token: $csrf"); fi
  fi
  if [ -n "$body" ]; then extra+=(-H "Content-Type: application/json" -d "$body"); fi
  curl -s -H "Origin: $BASE" "${extra[@]}" -X "$method" -w $'\n%{http_code}' "$BASE$path"
}

login() {
  local email="$1" pw="$2" jar="$3"
  rm -f "$jar"
  curl -s -c "$jar" -H "Origin: $BASE" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}" "$BASE/api/auth/login"
}

echo "=== 0) ローカルD1準備（状態リセット＋マイグレーション＋Turnstile無効化シード） ==="
rm -rf .wrangler/state
npx wrangler d1 migrations apply DB_MAIN --local >/dev/null 2>&1
npx wrangler d1 migrations apply DB_SHARD_1 --local >/dev/null 2>&1
npx wrangler d1 migrations apply DB_SHARD_2 --local >/dev/null 2>&1
npx wrangler d1 execute DB_MAIN --local -y --command \
  "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_auth','false',1) ON CONFLICT(key) DO UPDATE SET value='false'" \
  >/dev/null 2>&1
echo "done"

UA_EMAIL="ua-$(date +%s)@test.local"

echo "=== 1) create-admin.mjs で管理者をCLI登録 ==="
node scripts/create-admin.mjs --local --email admin@test.local --password 'admin-pass-123' \
  --username '管理人' --pepper 'test-pepper' > /tmp/create-admin-out.txt 2>&1
if [ $? -eq 0 ] && grep -q "完了" /tmp/create-admin-out.txt; then ok "create-admin.mjs"; else bad "create-admin.mjs"; cat /tmp/create-admin-out.txt; fi

echo "=== 2) wrangler dev 起動 ==="
WRANGLER_SEND_METRICS=false npx wrangler dev --port $PORT \
  --var ENVIRONMENT:development \
  --var PASSWORD_PEPPER:test-pepper \
  --var SESSION_HMAC_SECRET:test-hmac-secret \
  --var CSRF_HMAC_SECRET:test-csrf-secret \
  > /tmp/wrangler-dev-v5.log 2>&1 &
DEV_PID=$!
ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public-config" 2>/dev/null)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ $ready -eq 1 ] && ok "wrangler dev 起動" || { bad "wrangler dev 起動タイムアウト"; tail -30 /tmp/wrangler-dev-v5.log; exit 1; }

ADMIN_JAR=/tmp/v5-admin.jar; UA_JAR=/tmp/v5-ua.jar
rm -f "$ADMIN_JAR" "$UA_JAR"

echo "=== 3) 管理者ログイン（CLI登録アカウント・ハッシュ検証） ==="
resp=$(login "admin@test.local" "admin-pass-123" "$ADMIN_JAR")
role=$(echo "$resp" | $JQ '.user.role // empty')
[ "$role" = "admin" ] && ok "管理者ログイン&role=admin" || bad "管理者ログイン (resp=$resp)"

echo "=== 4) 管理設定: 投稿間隔を0に（テスト用） ==="
resp=$(req "/api/admin/settings" "$ADMIN_JAR" PUT '{"min_interval_new_sec":"0","require_turnstile_on_post":"false"}')
[ "$(echo "$resp" | tail -1)" = "200" ] && ok "設定変更" || bad "設定変更 ($resp)"

echo "=== 5) 半角制限（サーバー側検証） ==="
resp=$(curl -s -H "Origin: $BASE" -H "Content-Type: application/json" -d '{"email":"fw@test.local","password":"パスワード８文字","username":"x"}' -w $'\n%{http_code}' "$BASE/api/auth/register")
code=$(echo "$resp" | tail -1)
[ "$code" = "400" ] && ok "全角パスワード拒否" || bad "全角パスワード拒否 (code=$code resp=$resp)"
resp=$(curl -s -H "Origin: $BASE" -H "Content-Type: application/json" -d '{"email":"テスト＠例．こむ","password":"halfwidth-pass1","username":"x"}' -w $'\n%{http_code}' "$BASE/api/auth/register")
code=$(echo "$resp" | tail -1)
[ "$code" = "400" ] && ok "全角メール拒否" || bad "全角メール拒否 (code=$code)"

resp=$(curl -s -c "$UA_JAR" -H "Origin: $BASE" -H "Content-Type: application/json" -d "{\"email\":\"$UA_EMAIL\",\"password\":\"user-pass-1234\",\"username\":\"太郎\"}" -w $'\n%{http_code}' "$BASE/api/auth/register")
code=$(echo "$resp" | tail -1); uid=$(echo "$resp" | head -1 | $JQ '.user.user_id // empty' 2>/dev/null)
[ "$code" = "200" ] && [ -n "$uid" ] && ok "通常ユーザー登録（半角）" || bad "通常ユーザー登録 ($resp)"

echo "=== 6) /status の解放（ログインユーザーOK・匿名401） ==="
code=$(req "/api/status" "" | tail -1)
[ "$code" = "401" ] && ok "匿名は401" || bad "匿名 (code=$code)"
code=$(req "/api/status" "$UA_JAR" | tail -1)
[ "$code" = "200" ] && ok "ログインユーザーは200" || bad "ログインユーザー (code=$code)"
sleep 4 # dosGuardの3秒インターバルを空ける
code=$(curl -s -b "$UA_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/admin/status")
[ "$code" = "200" ] && ok "旧パス /api/admin/status も200" || bad "旧パス (code=$code)"

echo "=== 7) スレッド作成と返信 ==="
resp=$(req "/api/threads" "$UA_JAR" POST '{"title":"完全削除テスト用スレッド","body":"1番目の投稿"}')
code=$(echo "$resp" | tail -1); TID=$(echo "$resp" | head -1 | $JQ '.thread_id // empty' 2>/dev/null)
[ "$code" = "201" ] && [ -n "$TID" ] && ok "スレッド作成 (id=$TID)" || bad "スレッド作成 ($resp)"
resp=$(req "/api/threads/$TID/posts" "$UA_JAR" POST '{"body":"返信その1"}')
[ "$(echo "$resp" | tail -1)" = "201" ] && ok "返信1" || bad "返信1 ($resp)"
resp=$(req "/api/threads/$TID/posts" "$UA_JAR" POST '{"body":"返信その2"}')
[ "$(echo "$resp" | tail -1)" = "201" ] && ok "返信2" || bad "返信2 ($resp)"

echo "=== 8) 管理スレッド一覧・ID検索・権限 ==="
resp=$(req "/api/admin/threads" "$UA_JAR")
code=$(echo "$resp" | tail -1)
[ "$code" = "403" ] && ok "非管理者はスレッド管理APIに403" || bad "非管理者 (code=$code)"
resp=$(req "/api/admin/threads" "$ADMIN_JAR")
found=$(echo "$resp" | head -1 | $JQ --argjson t "$TID" '[.threads[] | select(.thread_id == $t)][0].post_count // empty' 2>/dev/null)
[ "$found" = "3" ] && ok "一覧にスレッド存在・レス3件" || bad "一覧 ($found / $resp)"
resp=$(req "/api/admin/threads?threadId=$TID" "$ADMIN_JAR")
shard=$(echo "$resp" | head -1 | $JQ '.threads[0].shard // empty' 2>/dev/null)
[ "$shard" = "main" ] && ok "ID検索でshard=main解決" || bad "ID検索 ($resp)"

echo "=== 9) CSRF検証（トークン無しは403） ==="
code=$(curl -s -b "$ADMIN_JAR" -H "Origin: $BASE" -H "Content-Type: application/json" -d "{}" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/threads/$TID/purge")
[ "$code" = "403" ] && ok "CSRF無しは403" || bad "CSRF (code=$code)"

echo "=== 10) スレッド完全削除（レスごと） ==="
resp=$(req "/api/admin/threads/$TID/purge" "$ADMIN_JAR" POST "{}")
dp=$(echo "$resp" | head -1 | $JQ '.deletedPosts // empty' 2>/dev/null)
[ "$dp" = "3" ] && ok "完全削除 deletedPosts=3" || bad "完全削除 ($resp)"
code=$(req "/api/threads/$TID/posts" "$UA_JAR" | tail -1)
[ "$code" = "404" ] && ok "削除後は404" || bad "削除後 (code=$code)"
resp=$(req "/api/admin/threads?threadId=$TID" "$ADMIN_JAR")
n=$(echo "$resp" | head -1 | $JQ '.threads | length' 2>/dev/null)
[ "$n" = "0" ] && ok "ID検索でも存在しない" || bad "ID検索後 ($resp)"
grep -q "purge_thread" <(req "/api/admin/audit-log" "$ADMIN_JAR" | head -1) && ok "監査ログにpurge_thread" || bad "監査ログ"

echo "=== 11) BAN/解除 ==="
resp=$(req "/api/admin/users/$uid/ban" "$ADMIN_JAR" POST '{"reason":"テストBAN"}')
[ "$(echo "$resp" | tail -1)" = "200" ] && ok "BAN" || bad "BAN ($resp)"
code=$(curl -s -H "Origin: $BASE" -H "Content-Type: application/json" -d "{\"email\":\"$UA_EMAIL\",\"password\":\"user-pass-1234\"}" -o /dev/null -w '%{http_code}' "$BASE/api/auth/login")
[ "$code" = "403" ] && ok "BAN中はログイン403" || bad "BAN中ログイン (code=$code)"
resp=$(req "/api/admin/users/$uid/unban" "$ADMIN_JAR" POST "{}")
[ "$(echo "$resp" | tail -1)" = "200" ] && ok "BAN解除" || bad "BAN解除 ($resp)"
code=$(curl -s -H "Origin: $BASE" -H "Content-Type: application/json" -d "{\"email\":\"$UA_EMAIL\",\"password\":\"user-pass-1234\"}" -o /dev/null -w '%{http_code}' "$BASE/api/auth/login")
[ "$code" = "200" ] && ok "解除後ログイン200" || bad "解除後 (code=$code)"

echo "=== 片付け ==="
kill $DEV_PID 2>/dev/null; wait $DEV_PID 2>/dev/null
echo ""
echo "結果: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || echo "WITH FAILURES"
exit $FAIL
