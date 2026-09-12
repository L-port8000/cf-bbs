#!/usr/bin/env node
// cf-bbs v8 E2Eテスト Part B: 管理画面のauth_mode切替（JWT⇔HMAC/D1セッション）、
// db_shard_count設定、BANによる即時失効を検証する。
// 前提: test-v8-jwt-cluster.mjs 実行後、ADMIN_EMAIL をD1でrole='admin'に更新済みであること。
// 使い方: ADMIN_EMAIL=... node scripts/test-v8-hmac-admin.mjs
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:8787";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  console.error("ADMIN_EMAIL is required");
  process.exit(1);
}
const JAR = { admin: new Map(), victim: new Map() };
let adminCsrf = null;

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? " — " + extra : ""}`); }
}
function storeCookies(jar, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function api(jar, method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "Origin": BASE, ...headers, ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) storeCookies(jar, res);
  let data = null;
  try { data = await res.json(); } catch { }
  return { status: res.status, data };
}

console.log("=== A. 管理者ログイン（現行JWTモード）→ 設定変更 ===");
{
  const login = await api(JAR.admin, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: "adminpass123" });
  ok("管理者ログイン", login.status === 200 && login.data.user?.role === "admin", `status=${login.status}`);
  adminCsrf = login.data.csrfToken;
  const jwt = JAR.admin.get("bbs_session") ?? "";
  ok("JWTモードで発行されている", (jwt.match(/\./g) ?? []).length === 2);

  const inv1 = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "root" }, { "X-CSRF-Token": adminCsrf });
  ok("auth_mode=root は400", inv1.status === 400, JSON.stringify(inv1.data?.error ?? {}));
  const inv2 = await api(JAR.admin, "PUT", "/api/admin/settings", { db_shard_count: 9 }, { "X-CSRF-Token": adminCsrf });
  ok("db_shard_count=9 は400", inv2.status === 400);
  const inv3 = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "hmac'--" }, { "X-CSRF-Token": adminCsrf });
  ok("auth_mode=不正文字列は400", inv3.status === 400);

  const set1 = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "hmac" }, { "X-CSRF-Token": adminCsrf });
  ok("auth_mode=hmac へ切替", set1.status === 200 && set1.data.settings?.auth_mode === "hmac");
  const set2 = await api(JAR.admin, "PUT", "/api/admin/settings", { db_shard_count: 1 }, { "X-CSRF-Token": adminCsrf });
  ok("db_shard_count=1 へ切替", set2.status === 200 && set2.data.settings?.db_shard_count === 1);
  const set3 = await api(JAR.admin, "PUT", "/api/admin/settings", { db_shard_count: 3 }, { "X-CSRF-Token": adminCsrf });
  ok("db_shard_count=3 へ戻す", set3.status === 200 && set3.data.settings?.db_shard_count === 3);
}

console.log("=== B. HMACモード（D1セッション）で再ログイン ===");
{
  await api(JAR.admin, "POST", "/api/auth/logout", {});
  const login = await api(JAR.admin, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: "adminpass123" });
  ok("再ログイン成功", login.status === 200);
  adminCsrf = login.data.csrfToken;
  const sid = JAR.admin.get("bbs_session") ?? "";
  ok("Cookieが sid_ 接頭辞（D1セッション）", sid.startsWith("sid_"), sid.slice(0, 12) + "…");
  const me = await api(JAR.admin, "GET", "/api/auth/me");
  ok("D1セッションで me 成功", me.status === 200 && me.data.user?.role === "admin");

  const th = await api(JAR.admin, "POST", "/api/threads", { title: "HMACモードのスレッド", body: "D1セッション認証で投稿" }, { "X-CSRF-Token": adminCsrf });
  ok("HMACセッションでスレッド作成", th.status === 201, `thread=${th.data.thread_id}`);

  // 閲覧キャッシュ対策: 認証系はキャッシュされないため即座に見られる
  const me2 = await api(JAR.admin, "GET", "/api/auth/me");
  ok("2回目のme（D1 read）", me2.status === 200 && me2.data.user !== null);
}

console.log("=== C. BAN即時失効（HMACモード） ===");
const victimEmail = `v8victim-${Date.now()}@example.com`;
{
  const reg = await api(JAR.victim, "POST", "/api/auth/register", { email: victimEmail, password: "victimpass1", username: `v8victim-${Date.now() % 1000000}` });
  ok("犠牲ユーザー登録", reg.status === 200 || reg.status === 201);
  const sid = JAR.victim.get("bbs_session") ?? "";
  ok("犠牲者も sid_ で発行", sid.startsWith("sid_"));

  const users = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(victimEmail)}`);
  const victim = (users.data.users ?? []).find((u) => u.email === victimEmail);
  ok("ユーザー検索（管理者）", !!victim, `id=${victim?.user_id}`);

  const ban = await api(JAR.admin, "POST", `/api/admin/users/${victim.user_id}/ban`, { reason: "v8 test" }, { "X-CSRF-Token": adminCsrf });
  ok("BAN実行", ban.status === 200);

  const me = await api(JAR.victim, "GET", "/api/auth/me");
  ok("BAN後 即座に me=null（セッション即時失効）", me.status === 200 && me.data.user === null, JSON.stringify(me.data));

  const rel = await api(JAR.victim, "POST", "/api/auth/login", { email: victimEmail, password: "victimpass1" });
  ok("BANユーザーの再ログインは403", rel.status === 403, `status=${rel.status}`);
}

console.log("=== D. HMACモードでログアウト → 即時失効 → 設定をJWTへ戻す ===");
{
  const me0 = await api(JAR.admin, "GET", "/api/auth/me");
  ok("ログアウト前 me=あり", me0.data.user !== null);
  await api(JAR.admin, "POST", "/api/auth/logout", {});
  const me = await api(JAR.admin, "GET", "/api/auth/me");
  ok("ログアウト後 me=null（D1セッション削除済み）", me.status === 200 && me.data.user === null);

  // JWTへ戻してログインし直す（最終状態を既定に戻す）
  const login = await api(JAR.admin, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: "adminpass123" });
  ok("HMACモード中の再ログイン", login.status === 200);
  adminCsrf = login.data.csrfToken;
  const back = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "jwt" }, { "X-CSRF-Token": adminCsrf });
  ok("auth_mode=jwt へ復元", back.status === 200 && back.data.settings?.auth_mode === "jwt");
  await api(JAR.admin, "POST", "/api/auth/logout", {});
}

console.log(`\n結果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
