#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cf-bbs v11 ローカルE2Eテスト: 既定で外部ツール拒否 + APIキー（設定「高度な機能」）
//
// 検証内容:
//   1) Cookie+CSRFが有効でもOriginヘッダ無しの書き込みAPIは403 external_tool_blocked
//      （＝curl等の外部ツールは既定で拒否される・ユーザー要望「標準で外部ツールから
//        APIを叩けないようにする」の本体）
//   2) Originヘッダ付き（ブラウザ相当）なら従来どおり成功
//   3) 公開データのGETはOrigin無しでも従来どおり可能（閲覧は壊さない）
//   4) 他サイトOriginの偽装は403 invalid_origin
//   5) 設定「高度な機能」のAPIでAPIキーを発行 → cfbk_接頭辞・一覧はprefixのみ
//   6) APIキー（Authorization: Bearer）ならOrigin無し・Cookie無しで投稿できる
//   7) 無効/失効済みキーは401 invalid_api_key
//   8) APIキーでのAPIキー管理（発行/一覧/失効）は403（自立増殖防止）
//   9) APIキーでの管理APIは403（role=userへ強制されるため・管理者自身のキーでも）
//  10) 他人のキーは失効できない（404）
//  11) パスワード変更（0007のセッション失効）でもAPIキーは無効化されない
//
// 事前準備（run-regression.sh が自動で実施する。単体で実行する場合のみ）:
//   npx wrangler d1 migrations apply DB_MAIN --local
//   npx wrangler d1 execute DB_MAIN --local -y --command "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_auth','false',1),('require_turnstile_on_post','false',1),('min_interval_new_sec','0',1),('min_interval_regular_sec','0',1) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
//   node scripts/create-admin.mjs --local --email v11-admin@test.local --password 'v11-admin-pass' --username 'v11管理' --pepper test-pepper
// 使い方: node scripts/test-v11-api-keys.mjs
// ---------------------------------------------------------------------------
const BASE = "http://127.0.0.1:8787";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "v11-admin@test.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "v11-admin-pass";
const JAR = { a: new Map(), b: new Map(), admin: new Map() };

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
function csrfOf(jar) {
  return jar.get("bbs_csrf") ?? "";
}

// ブラウザ相当のリクエスト（Origin付き・Cookie+CSRF自動付与）
async function api(jar, method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Origin": BASE,
      ...(jar && csrfOf(jar) && method !== "GET" ? { "X-CSRF-Token": csrfOf(jar) } : {}),
      ...headers,
      ...(jar ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) storeCookies(jar, res);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, res };
}

// 外部ツール相当のリクエスト（Origin/Cookie/CSRF無し。ヘッダはheadersで明示したものだけ）
async function external(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, res };
}

async function main() {
  const ts = Date.now() % 1000000;
  const emailA = `v11-a-${ts}@example.com`;
  const emailB = `v11-b-${ts}@example.com`;
  const pwA = "password-A1";
  const pwB = "password-B1";

  console.log("=== 0) 準備: ユーザーA/Bを登録 ===");
  {
    const ra = await api(JAR.a, "POST", "/api/auth/register", { email: emailA, password: pwA, username: `v11userA${ts}` });
    ok("ユーザーA登録", ra.status === 200, `status=${ra.status}`);
    const rb = await api(JAR.b, "POST", "/api/auth/register", { email: emailB, password: pwB, username: `v11userB${ts}` });
    ok("ユーザーB登録", rb.status === 200, `status=${rb.status}`);
  }

  console.log("=== 1) 既定で外部ツール拒否（Origin無しの書き込みは403） ===");
  let threadIdOfA = 0;
  {
    // Origin無しでもCookie+CSRFは正しい（=盗んだ認証情報だけでは書き込めない）
    const blocked = await external("POST", "/api/threads", { title: "外部ツールからの作成", body: "これは拒否されるべき" }, {
      Cookie: cookieHeader(JAR.a),
      "X-CSRF-Token": csrfOf(JAR.a),
    });
    ok("Origin無しスレッド作成は403 external_tool_blocked", blocked.status === 403 && blocked.data.error?.code === "external_tool_blocked", `status=${blocked.status} code=${blocked.data.error?.code}`);

    // Origin付き（ブラウザ相当）なら成功
    const browser = await api(JAR.a, "POST", "/api/threads", { title: "v11外部ツール拒否テスト", body: "ブラウザからの投稿は従来どおり可能" });
    ok("Origin付きスレッド作成は201", browser.status === 201, `status=${browser.status}`);
    threadIdOfA = browser.data.thread_id;

    // 公開データのGETはOrigin無しでも可能（閲覧は壊さない）
    const publicGet = await external("GET", "/api/threads?limit=5");
    ok("公開GETはOrigin無しでも200", publicGet.status === 200 && Array.isArray(publicGet.data.threads), `status=${publicGet.status}`);

    // 他サイトOriginの偽装は403 invalid_origin
    const forged = await api(JAR.a, "POST", "/api/threads", { title: "偽装", body: "x" }, { "Origin": "https://evil.example.com" });
    ok("他サイトOriginの偽装は403 invalid_origin", forged.status === 403 && forged.data.error?.code === "invalid_origin", `status=${forged.status} code=${forged.data.error?.code}`);
  }

  console.log("=== 2) APIキーの発行（設定「高度な機能」API） ===");
  let apiKeyFull = "";
  let keyIdOfA = "";
  {
    const noLabel = await api(JAR.a, "POST", "/api/auth/api-keys", { label: "" });
    ok("ラベル空は400", noLabel.status === 400, `status=${noLabel.status}`);

    const created = await api(JAR.a, "POST", "/api/auth/api-keys", { label: "自作ツール" });
    ok("APIキー発行は201", created.status === 201, `status=${created.status}`);
    ok("キーはcfbk_接頭辞", typeof created.data.key === "string" && created.data.key.startsWith("cfbk_"));
    ok("key_idはak_接頭辞", typeof created.data.key_id === "string" && created.data.key_id.startsWith("ak_"));
    apiKeyFull = created.data.key ?? "";
    keyIdOfA = created.data.key_id ?? "";

    const list = await api(JAR.a, "GET", "/api/auth/api-keys");
    const row = (list.data.keys ?? []).find((k) => k.key_id === keyIdOfA);
    // key_prefix = "cfbk_" + 8文字 の計13文字（以後の表示用。全文・ハッシュは返さない）
    ok("一覧に発行したキーが載る（prefixのみ）", !!row && row.key_prefix === apiKeyFull.slice(0, 13), `prefix=${row?.key_prefix}`);
    ok("一覧にキー全文・ハッシュは含まれない", !JSON.stringify(list.data).includes(apiKeyFull) && !JSON.stringify(list.data).includes("key_hash"));

    // 発行・失効は監査ログに載る（管理者画面のデータソース）
    void 0;
  }

  console.log("=== 3) APIキーなら外部ツールから投稿できる ===");
  {
    const posted = await external("POST", `/api/threads/${threadIdOfA}/posts`, { body: "APIキーからの投稿" }, {
      Authorization: `Bearer ${apiKeyFull}`,
    });
    ok("Bearer+Origin無しの返信は201", posted.status === 201, `status=${posted.status}`);

    // Cookieを付けずにキーだけで動く（外部ツールの使い勝手）
    const created = await external("POST", "/api/threads", { title: "APIキーで立てたスレッド", body: "キーからの新規作成" }, {
      Authorization: `Bearer ${apiKeyFull}`,
    });
    ok("Bearerでのスレッド作成は201", created.status === 201, `status=${created.status}`);

    // 期限切れ/偽造キーは401
    const bad = await external("POST", `/api/threads/${threadIdOfA}/posts`, { body: "偽造キー" }, {
      Authorization: "Bearer cfbk_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    });
    ok("無効キーは401 invalid_api_key", bad.status === 401 && bad.data.error?.code === "invalid_api_key", `status=${bad.status} code=${bad.data.error?.code}`);

    // 投稿の表示名はキー所有者（A）のユーザー名になる
    const posts = await external("GET", `/api/threads/${threadIdOfA}/posts`);
    const mine = (posts.data.posts ?? []).find((p) => p.body === "APIキーからの投稿");
    ok("キー投稿の表示名は所有者A", !!mine && mine.username === `v11userA${ts}`, `username=${mine?.username}`);
  }

  console.log("=== 4) APIキーの権限境界 ===");
  {
    // キーによるキー管理は禁止（自立増殖防止）
    const mgmtList = await external("GET", "/api/auth/api-keys", undefined, { Authorization: `Bearer ${apiKeyFull}` });
    ok("Bearerでのキー一覧は403", mgmtList.status === 403 && mgmtList.data.error?.code === "api_key_management_forbidden", `status=${mgmtList.status}`);
    const mgmtCreate = await external("POST", "/api/auth/api-keys", { label: "x" }, { Authorization: `Bearer ${apiKeyFull}` });
    ok("Bearerでのキー発行は403", mgmtCreate.status === 403, `status=${mgmtCreate.status}`);
    const mgmtRevoke = await external("DELETE", `/api/auth/api-keys/${keyIdOfA}`, undefined, { Authorization: `Bearer ${apiKeyFull}` });
    ok("Bearerでのキー失効は403", mgmtRevoke.status === 403, `status=${mgmtRevoke.status}`);

    // 他人（B）のCookieではAのキーを失効できない
    const foreignRevoke = await api(JAR.b, "DELETE", `/api/auth/api-keys/${keyIdOfA}`);
    ok("他人のキー失効は404", foreignRevoke.status === 404, `status=${foreignRevoke.status}`);

    // 管理APIは管理者自身のキーでも403（role=user強制）
    const adminLogin = await api(JAR.admin, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (adminLogin.status === 200 && adminLogin.data.user?.role === "admin") {
      const adminKey = await api(JAR.admin, "POST", "/api/auth/api-keys", { label: "管理用（拒否されるはず）" });
      const adminOverview = await external("GET", "/api/admin/overview", undefined, { Authorization: `Bearer ${adminKey.data.key}` });
      ok("管理者自身のキーでも管理APIは403", adminOverview.status === 403, `status=${adminOverview.status}`);
      const adminOverviewCookie = await api(JAR.admin, "GET", "/api/admin/overview");
      ok("ブラウザログインなら管理APIは200", adminOverviewCookie.status === 200, `status=${adminOverviewCookie.status}`);
    } else {
      console.log("  （管理者シードが無いため管理APIテストをスキップ: run-regression.sh経由で実行してください）");
    }
  }

  console.log("=== 5) 失効とパスワード変更 ===");
  {
    // パスワード変更（0007でセッション失効）でもAPIキーは生きる
    const newPw = "password-A2";
    const change = await api(JAR.a, "POST", "/api/auth/password", { currentPassword: pwA, newPassword: newPw });
    ok("Aがパスワード変更", change.status === 200, `status=${change.status}`);
    const afterPwChange = await external("POST", `/api/threads/${threadIdOfA}/posts`, { body: "パスワード変更後もキーは有効" }, {
      Authorization: `Bearer ${apiKeyFull}`,
    });
    ok("パスワード変更後もAPIキーは有効", afterPwChange.status === 201, `status=${afterPwChange.status}`);

    // 失効 → 即401
    const revoke = await api(JAR.a, "DELETE", `/api/auth/api-keys/${keyIdOfA}`);
    ok("キー失効は200", revoke.status === 200, `status=${revoke.status}`);
    const afterRevoke = await external("POST", `/api/threads/${threadIdOfA}/posts`, { body: "失効後の投稿" }, {
      Authorization: `Bearer ${apiKeyFull}`,
    });
    ok("失効後のキーは401 invalid_api_key", afterRevoke.status === 401 && afterRevoke.data.error?.code === "invalid_api_key", `status=${afterRevoke.status}`);

    const list = await api(JAR.a, "GET", "/api/auth/api-keys");
    ok("失効したキーは一覧から消える", !(list.data.keys ?? []).some((k) => k.key_id === keyIdOfA));
  }

  console.log(`\n=== 結果: ${pass} passed / ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exit(1);
});
