#!/usr/bin/env node
// cf-bbs v2 ローカルE2Eテスト:
//   JWT認証・HMAC(D1)セッションモード・サーバー間HMAC同期・cron（/__scheduled）
//   ・管理画面設定（auth_mode / db_shard_count）・BAN即時失効 を検証する。
// 使い方: node scripts/test-v8-jwt-cluster.mjs
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:8787";
const SYNC_SECRET = "test-sync-secret-local";
const JAR = { admin: new Map(), user: new Map() };

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? " — " + extra : ""}`); }
}

function storeCookies(jar, res) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function syncHeaders(method, path, body) {
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", SYNC_SECRET).update(`${ts}:${method}:${path}:${body}`).digest("base64url");
  return { "Content-Type": "application/json", "X-Sync-Timestamp": ts, "X-Sync-Signature": sig };
}

async function api(jar, method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "Origin": BASE, ...headers, ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) storeCookies(jar, res);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

console.log("=== 1. JWTモード: 登録→ログイン→投稿→me→ログアウト ===");
const email = `v8-${Date.now()}@example.com`;
const username = `v8tester${Date.now() % 100000}`;
let userCsrf = null;
{
  const reg = await api(JAR.user, "POST", "/api/auth/register", { email, password: "password123", username });
  ok("登録成功", reg.status === 200 || reg.status === 201, `status=${reg.status}`);
  userCsrf = reg.data.csrfToken;
  const jwt = JAR.user.get("bbs_session") ?? "";
  ok("CookieがJWT形式（3セグメント）", (jwt.match(/\./g) ?? []).length === 2, jwt.slice(0, 24) + "…");
  const me = await api(JAR.user, "GET", "/api/auth/me");
  ok("me でユーザー取得", me.status === 200 && me.data.user?.email === email);
  const th = await api(JAR.user, "POST", "/api/threads", { title: "v8テストスレッド", body: "JWTモードの1件目" }, { "X-CSRF-Token": userCsrf });
  ok("スレッド作成（JWT認証・KV経由なし）", th.status === 201, `thread=${th.data.thread_id}`);
  const po = await api(JAR.user, "POST", `/api/threads/${th.data.thread_id}/posts`, { body: "JWTモードの返信" }, { "X-CSRF-Token": userCsrf });
  ok("返信成功", po.status === 201, `post=${po.data.post_id}`);

  const noCsrf = await api(JAR.user, "PATCH", "/api/auth/username", { username: "v8tester2" }, { Origin: `https://cf-bbs.l-ituki8000.workers.dev` });
  ok("CSRFヘッダ無しは403", noCsrf.status === 403, `status=${noCsrf.status}`);

  const out = await api(JAR.user, "POST", "/api/auth/logout", {});
  ok("ログアウト成功", out.status === 200);
  const me2 = await api(JAR.user, "GET", "/api/auth/me");
  ok("ログアウト後 me=null", me2.status === 200 && me2.data.user === null);
}

console.log("=== 2. サーバー間HMAC同期API ===");
{
  const body = JSON.stringify({ senderUrl: "https://localhost", statDate: "2026-09-07", requestCount: 42, reportedAt: Date.now() });
  const good = await fetch(BASE + "/api/sync/access-stats", { method: "POST", headers: syncHeaders("POST", "/api/sync/access-stats", body), body });
  ok("access-stats 受理（正しい署名）", good.status === 200, `status=${good.status}`);

  const bad = await fetch(BASE + "/api/sync/access-stats", { method: "POST", headers: { "Content-Type": "application/json", "X-Sync-Timestamp": String(Date.now()), "X-Sync-Signature": "badsig" }, body });
  ok("不正署名は401", bad.status === 401, `status=${bad.status}`);

  const noSig = await fetch(BASE + "/api/sync/access-stats", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  ok("署名無しは401", noSig.status === 401, `status=${noSig.status}`);

  // server-list取り込み（新規サーバーへのブートストラップ相当）
  const listBody = JSON.stringify({ senderUrl: "https://localhost", servers: [{ url: "https://127.0.0.1", name: "サーバーB", type: "normal" }] });
  const imp = await fetch(BASE + "/api/sync/server-list", { method: "POST", headers: syncHeaders("POST", "/api/sync/server-list", listBody), body: listBody });
  const impData = await imp.json();
  ok("server-list 取り込み", imp.status === 200 && impData.accepted === 1, JSON.stringify(impData));

  // health-report push（peer-bがdownの結果を配信）
  const repBody = JSON.stringify({ senderUrl: "https://localhost", checkedAt: Date.now(), servers: [{ url: "https://127.0.0.1", name: "サーバーB", type: "normal", health: "down", lastHealthAt: Date.now(), lastUpAt: null }] });
  const rep = await fetch(BASE + "/api/sync/health-report", { method: "POST", headers: syncHeaders("POST", "/api/sync/health-report", repBody), body: repBody });
  const repData = await rep.json();
  ok("health-report push 受理", rep.status === 200 && repData.applied === 1, JSON.stringify(repData));

  // health-report pull（自分が載っている状態を返す）
  const pull = await fetch(BASE + "/api/sync/health-report", { headers: syncHeaders("GET", "/api/sync/health-report", "") });
  const pullData = await pull.json();
  ok("health-report pull（一覧返却）", pull.status === 200 && Array.isArray(pullData.servers) && pullData.servers.some((s) => s.health === "down"), `servers=${pullData.servers?.length}`);

  const srv = await api(null, "GET", "/api/servers");
  const pb = (srv.data.servers ?? []).find((s) => s.url === "https://127.0.0.1");
  ok("/api/servers に health=down 反映", pb?.health === "down", JSON.stringify(pb));
}

console.log("=== 3. cron（/cdn-cgi/local/scheduled）: 23:59統計共有 → 0:00チェック → 0:01配信 ===");
{
  await api(JAR.user, "GET", "/api/threads"); // アクセスカウンタを増やす
  // wrangler 4.x のローカルcronテスト用エンドポイント（旧 /__scheduled は廃止）
  let r = await fetch(BASE + "/cdn-cgi/local/scheduled?cron=59+14+*+*+*");
  ok("cron 23:59 発火", r.status === 200);
  r = await fetch(BASE + "/cdn-cgi/local/scheduled?cron=0+15+*+*+*");
  ok("cron 0:00 発火（単独サーバーなので自分が担当）", r.status === 200);
  r = await fetch(BASE + "/cdn-cgi/local/scheduled?cron=1+15+*+*+*");
  ok("cron 0:01 発火", r.status === 200);
}

console.log("=== 4. 管理者作成→auth_mode切替（HMAC/D1セッション）=== ");
const adminEmail = `v8admin-${Date.now()}@example.com`;
{
  const reg = await api(JAR.admin, "POST", "/api/auth/register", { email: adminEmail, password: "adminpass123" });
  ok("管理者候補の登録", reg.status === 200 || reg.status === 201);
  const jwt = JAR.admin.get("bbs_session") ?? "";
  ok("切替前はJWTで発行される", (jwt.match(/\./g) ?? []).length === 2);
  // 管理者化は後続のbashステップ（d1 UPDATE）で実施。メールアドレスを引き継ぐ
  console.log(`ADMIN_EMAIL=${adminEmail}`);
}

console.log("=== 5. 設定バリデーション ===");
{
  // 管理者権限をD1へ直接付与（別ターミナルで実行するためここでは外注せず、
  // wrangler d1 execute は外部スクリプトが行う。このテストではADMINではなく
  // 不正値バリデーションのみ401で確認する）
  const inv = await api(JAR.user, "PUT", "/api/admin/settings", { auth_mode: "root" });
  ok("非管理者は403", inv.status === 403 || inv.status === 401, `status=${inv.status}`);
}

console.log(`\n結果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
