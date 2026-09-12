#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cf-bbs v11.2 ローカルE2Eテスト: 管理画面の手動レスポンスチェック
//
// 検証内容:
//   1) 一般ユーザー（非管理者）のチェック実行は403
//   2) 未管理者・外部ツール（Origin無し）からのチェック実行は403 external_tool_blocked
//   3) 存在しないURLのチェックは404 not_found（回数も消費しない）
//   4) 自分自身のURLのチェックは400 cannot_check_self（常に稼働中表示のため不要）
//   5) 到達不能サーバーのチェックは200 up=false → health="down" 反映・残回数が減る
//   6) 1日10回の上限: 11回目は429 quota_exceeded（カウンタは巻き戻り・以後も429）
//   7) 追加APIは応答確認に失敗したURLを登録しない（400 unreachable_server・従来仕様）
//
// ※「応答あり→稼働中へ復旧（markServerUp）」の経路は、ローカルに生きた
//   httpsのcf-bbsサーバーが必要なため（normalizeUrlがhttps強制）、E2Eでは
//   直接検証しない。SQL自体はdown経路と同一のUPDATEで、addServerCore経由の
//   実運用でカバーされる。
//
// 事前準備（run-regression.sh が自動で実施する。単体で実行する場合のみ）:
//   npx wrangler d1 migrations apply DB_MAIN --local
//   npx wrangler d1 execute DB_MAIN --local -y --command "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_auth','false',1),('require_turnstile_on_post','false',1),('min_interval_new_sec','0',1),('min_interval_regular_sec','0',1) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
//   node scripts/create-admin.mjs --local --email v11-admin@test.local --password 'v11-admin-pass' --username 'v11管理' --pepper test-pepper
// 使い方: node scripts/test-v11-server-check.mjs（wrangler dev起動後に実行）
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:8787";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "v11-admin@test.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "v11-admin-pass";
const JAR = { a: new Map(), admin: new Map() };

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

// 外部ツール相当のリクエスト（Origin/Cookie/CSRF無し）
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

// ローカルD1へ直接SQL（devインスタンスと同じsqliteを触る。実行中でもWALで可）
function d1(sql) {
  execSync(`npx wrangler d1 execute DB_MAIN --local -y --json --command "${sql.replace(/"/g, '\\"')}"`, {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function main() {
  const ts = Date.now() % 1000000;
  const emailA = `v11sc-${ts}@example.com`;
  // 到達が確実に失敗する（DNS解決不能な・RFC2606予約ドメインの）URL
  const deadUrl = `https://dead-check-${ts}.example.com`;
  const unknownUrl = `https://unknown-check-${ts}.example.com`;

  console.log("=== 0) 準備: テスト用サーバー行（health=down）とユーザー ===");
  {
    // 手動チェックは既知サーバー一覧に存在するURLしか受け付けないため、
    // 「一時的なエラーで応答なしになっているサーバー」を直接INSERTして再現する
    d1("DELETE FROM admin_daily_quotas;");
    d1(`DELETE FROM known_servers WHERE url LIKE 'https://dead-check-%' OR url LIKE 'https://unknown-check-%';`);
    d1(`INSERT INTO known_servers (url, name, type, added_at, last_synced_at, health) VALUES ('${deadUrl}', '死亡テストサーバー', 'normal', 1, 1, 'down');`);

    const ra = await api(JAR.a, "POST", "/api/auth/register", { email: emailA, password: "password-A1", username: `v11sc${ts}` });
    ok("一般ユーザーA登録", ra.status === 200, `status=${ra.status}`);
    const la = await api(JAR.admin, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    ok("管理者ログイン", la.status === 200 && la.data.user?.role === "admin", `status=${la.status}`);
  }

  console.log("=== 1) 権限とOriginの検証 ===");
  {
    const user = await api(JAR.a, "POST", "/api/admin/servers/check", { url: deadUrl });
    ok("一般ユーザーのチェックは403", user.status === 403, `status=${user.status}`);

    const ext = await external("POST", "/api/admin/servers/check", { url: deadUrl }, { Cookie: cookieHeader(JAR.admin), "X-CSRF-Token": csrfOf(JAR.admin) });
    ok("Origin無し（外部ツール）のチェックは403", ext.status === 403 && ext.data.error?.code === "external_tool_blocked", `status=${ext.status} code=${ext.data.error?.code}`);

    const noCsrf = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: deadUrl }, { "X-CSRF-Token": "invalid" });
    ok("CSRF不正のチェックは403", noCsrf.status === 403, `status=${noCsrf.status}`);
  }

  console.log("=== 2) 存在しないURL・自分自身 ===");
  {
    const unknown = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: unknownUrl });
    ok("一覧に無いURLは404", unknown.status === 404 && unknown.data.error?.code === "not_found", `status=${unknown.status} code=${unknown.data.error?.code}`);

    const self = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: "https://bbs.example.com" });
    ok("自分自身のチェックは400 cannot_check_self", self.status === 400 && self.data.error?.code === "cannot_check_self", `status=${self.status} code=${self.data.error?.code}`);
  }

  console.log("=== 3) 到達不能サーバーのチェック（down反映・残回数） ===");
  {
    const r1 = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: deadUrl });
    ok("応答なしのチェックは200 up=false", r1.status === 200 && r1.data.up === false, `status=${r1.status} up=${r1.data.up}`);
    ok("healthはdownへ更新", r1.data.health === "down", `health=${r1.data.health}`);
    ok("残回数は9", r1.data.remainingChecks === 9, `remaining=${r1.data.remainingChecks}`);
    ok("メッセージ付き", typeof r1.data.message === "string" && r1.data.message.includes("本日の残り: 9/10"), `message=${r1.data.message}`);
  }

  console.log("=== 4) 1日10回の上限 ===");
  {
    // セクション3で1回消費済み（残9）→ さらに9回で計10回（残0）
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: deadUrl });
      if (last.status !== 200) break;
    }
    ok("2〜10回目は200（10回目で残0）", last?.status === 200 && last?.data?.remainingChecks === 0, `status=${last?.status} remaining=${last?.data?.remainingChecks}`);

    const over = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: deadUrl });
    ok("11回目は429 quota_exceeded", over.status === 429 && over.data.error?.code === "quota_exceeded", `status=${over.status} code=${over.data.error?.code}`);

    const overAgain = await api(JAR.admin, "POST", "/api/admin/servers/check", { url: deadUrl });
    ok("12回目も429（カウンタ巻き戻り確認）", overAgain.status === 429 && overAgain.data.error?.code === "quota_exceeded", `status=${overAgain.status}`);

    // 429の巻き戻しでカウンタが10のままであることをD1で直接確認
    let used = -1;
    try {
      const out = execSync(
        `npx wrangler d1 execute DB_MAIN --local -y --json --command "SELECT used FROM admin_daily_quotas LIMIT 1;"`,
        { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }
      );
      const parsed = JSON.parse(out);
      used = parsed?.[0]?.results?.[0]?.used ?? -1;
    } catch { /* 権限等で失敗してもテスト本体は継続 */ }
    ok("カウンタは10のまま（巻き戻り）", used === 10, `used=${used}`);
  }

  console.log("=== 5) 追加APIの応答確認（登録前チェック） ===");
  {
    const add = await api(JAR.admin, "POST", "/api/admin/servers", { url: unknownUrl, name: "死んでるはず" });
    ok("応答しないURLは追加できない（400 unreachable_server）", add.status === 400 && add.data.error?.code === "unreachable_server", `status=${add.status} code=${add.data.error?.code}`);
  }

  console.log(`\n=== 結果: ${pass} passed / ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exit(1);
});
