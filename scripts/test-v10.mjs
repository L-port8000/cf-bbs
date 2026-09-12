#!/usr/bin/env node
// cf-bbs v10 ローカルE2Eテスト:
//   - スレッド名検索（部分一致・大文字小文字・LIKE特殊文字エスケープ）
//   - 登録IP保持トグル（既定OFF→OFF時は保存されない / ON→保存 / 一括消去）
//   - 管理者によるパスワード再設定（自動生成・明示指定・弱パスワード拒否・
//     権限・CSRF・監査ログ・v10.1: 全モードで即時セッション失効）
//   - サーバー自動削除伝播（集約レポートでしきい値到達→削除 / 未満→日数反映 /
//     単独報告ではカウントしない / server-removed同期・署名必須）
//   - 利用規約ページの配信・新設定キーのバリデーション
// 使い方: bash scripts/test-v10.sh（このファイルはtest-v10.shから呼ばれる）
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:8817";
const SYNC_SECRET = "test-sync-secret-local";
const JAR = { admin: new Map(), a: new Map(), b: new Map(), c: new Map() };

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
function syncHeaders(method, path, body) {
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", SYNC_SECRET).update(`${ts}:${method}:${path}:${body}`).digest("base64url");
  return { "Content-Type": "application/json", "X-Sync-Timestamp": ts, "X-Sync-Signature": sig };
}

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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// /api/serversは同一IPあたり2秒インターバルのDoSガードがあるため、
// 429時は待ってリトライするヘルパー
async function getServers() {
  for (let i = 0; i < 4; i++) {
    const r = await api(null, "GET", "/api/servers");
    if (r.status === 200 && r.data?.servers) return r.data;
    await sleepMs(2200);
  }
  return { servers: [] };
}

async function main() {
  const ts = Date.now() % 10000000;
  const emailA = `v10-a-${ts}@example.com`;
  const emailB = `v10-b-${ts}@example.com`;
  const emailC = `v10-c-${ts}@example.com`;
  const pwA = "password-A1";
  const pwB = "password-B2";
  const pwC = "password-C3";
  const pwReset = "reset-pass-9";

  console.log("=== 0) 管理者ログイン ===");
  {
    const r = await api(JAR.admin, "POST", "/api/auth/login", { email: "v10-admin@test.local", password: "admin-pass-123" });
    ok("管理者ログイン", r.status === 200 && r.data.user?.role === "admin", `status=${r.status}`);
  }

  console.log("=== 1) スレッド名検索 ===");
  {
    // 投稿間隔制限回避のため少し待たずに連続投稿できるようシード済み（min_interval=0）
    const t1 = await api(JAR.admin, "POST", "/api/threads", { title: `v10検索ターゲットXYZ${ts}`, body: "検索テスト用1" });
    const t2 = await api(JAR.admin, "POST", "/api/threads", { title: `通常スレッドABC${ts}`, body: "検索テスト用2" });
    ok("検索用スレッド2件作成", t1.status === 201 && t2.status === 201, `s1=${t1.status} s2=${t2.status}`);

    const hit = await api(null, "GET", `/api/threads?limit=30&q=${encodeURIComponent(`XYZ${ts}`)}`);
    ok("部分一致で1件ヒット", hit.status === 200 && hit.data.threads?.length === 1 && hit.data.threads[0].title.includes(`XYZ${ts}`), `n=${hit.data.threads?.length}`);

    const hitUpper = await api(null, "GET", `/api/threads?limit=30&q=${encodeURIComponent(`xyz${ts}`)}`);
    ok("半角大文字小文字を区別しない", hitUpper.status === 200 && hitUpper.data.threads?.length === 1, `n=${hitUpper.data.threads?.length}`);

    const hitAbc = await api(null, "GET", `/api/threads?limit=30&q=${encodeURIComponent(`ABC${ts}`)}`);
    ok("別キーワードで別スレッドがヒット", hitAbc.status === 200 && hitAbc.data.threads?.length === 1 && hitAbc.data.threads[0].title.includes(`ABC${ts}`), `n=${hitAbc.data.threads?.length}`);

    const none = await api(null, "GET", `/api/threads?limit=30&q=${encodeURIComponent(`存在しない${ts}`)}`);
    ok("ヒットなしは空配列", none.status === 200 && none.data.threads?.length === 0, `n=${none.data.threads?.length}`);

    const wild = await api(null, "GET", `/api/threads?limit=30&q=${encodeURIComponent("%XYZ" + ts)}`);
    ok("LIKE特殊文字(%)は素の文字として扱う（500にならない・ワイルドカード化しない）", wild.status === 200 && wild.data.threads?.length === 0, `n=${wild.data.threads?.length}`);

    const all = await api(null, "GET", `/api/threads?limit=30&q=`);
    ok("空qは通常の一覧（200）", all.status === 200 && (all.data.threads?.length ?? 0) >= 2, `n=${all.data.threads?.length}`);
  }

  console.log("=== 2) 登録IP保持トグル（既定OFF） ===");
  {
    const reg = await api(JAR.a, "POST", "/api/auth/register", { email: emailA, password: pwA, username: `v10userA${ts % 100000}` });
    ok("ユーザーA登録（IP記録OFF）", reg.status === 200, `status=${reg.status}`);
    const list = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(emailA)}`);
    const ua = list.data.users?.[0];
    ok("OFF時はregistration_ipがnull", ua?.registration_ip === null || ua?.registration_ip === undefined, `ip=${ua?.registration_ip}`);
  }

  console.log("=== 3) IP記録ON→保存→一括消去 ===");
  {
    const setOn = await api(JAR.admin, "PUT", "/api/admin/settings", { record_registration_ip: "1" });
    ok("record_registration_ip=1に設定", setOn.status === 200 && setOn.data.settings?.record_registration_ip === true, `status=${setOn.status}`);

    const reg = await api(JAR.b, "POST", "/api/auth/register", { email: emailB, password: pwB, username: `v10userB${ts % 100000}` });
    ok("ユーザーB登録（IP記録ON）", reg.status === 200, `status=${reg.status}`);
    const list = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(emailB)}`);
    const ub = list.data.users?.[0];
    ok("ON時は登録IPが保存・表示される", typeof ub?.registration_ip === "string" && ub.registration_ip.length > 0, `ip=${ub?.registration_ip}`);

    const purge = await api(JAR.admin, "POST", "/api/admin/privacy/purge-registration-ips", {});
    ok("一括消去API成功", purge.status === 200 && (purge.data.cleared ?? 0) >= 1, `cleared=${purge.data.cleared}`);
    const list2 = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(emailB)}`);
    ok("消去後はnullに戻る", list2.data.users?.[0]?.registration_ip === null, `ip=${list2.data.users?.[0]?.registration_ip}`);

    const setOff = await api(JAR.admin, "PUT", "/api/admin/settings", { record_registration_ip: "0" });
    ok("record_registration_ip=0へ戻す", setOff.status === 200 && setOff.data.settings?.record_registration_ip === false, `status=${setOff.status}`);
  }

  console.log("=== 4) 設定キーのバリデーション ===");
  {
    const bad1 = await api(JAR.admin, "PUT", "/api/admin/settings", { record_registration_ip: "maybe" });
    ok("record_registration_ip=maybeは400", bad1.status === 400, `status=${bad1.status}`);
    const bad2 = await api(JAR.admin, "PUT", "/api/admin/settings", { server_auto_removal_days: "8" });
    ok("server_auto_removal_days=8は400", bad2.status === 400, `status=${bad2.status}`);
    const good = await api(JAR.admin, "PUT", "/api/admin/settings", { server_auto_removal_days: "3" });
    ok("server_auto_removal_days=3は200", good.status === 200 && good.data.settings?.server_auto_removal_days === 3, `status=${good.status}`);
  }

  console.log("=== 5) 管理者によるパスワード再設定（JWTモード） ===");
  {
    // JWTのiatは秒単位のため、登録と再設定が同一秒だと「同一秒発行トークンは
    // 猶予扱い」の仕様（自己変更直後の再発行トークン保護）に一致してしまい、
    // 失効判定を検証できない。秒境界を跨ぐまで待ってから再設定する。
    await sleepMs(1200);
    const list = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(emailA)}`);
    const uidA = list.data.users?.[0]?.user_id;
    ok("ユーザーAのuser_id取得", !!uidA);

    // CSRF無し → 403
    const noCsrf = await fetch(BASE + `/api/admin/users/${uidA}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE, Cookie: cookieHeader(JAR.admin) },
      body: JSON.stringify({ password: "" }),
    });
    ok("CSRFトークン無しは403", noCsrf.status === 403, `status=${noCsrf.status}`);

    // 一般ユーザーが実行 → 403
    const nonAdmin = await api(JAR.b, "POST", `/api/admin/users/${uidA}/reset-password`, { password: "" });
    ok("一般ユーザー実行は403", nonAdmin.status === 403, `status=${nonAdmin.status}`);

    // 弱パスワード → 400
    const weak = await api(JAR.admin, "POST", `/api/admin/users/${uidA}/reset-password`, { password: "short7" });
    ok("7文字は400", weak.status === 400, `status=${weak.status}`);
    const zenkaku = await api(JAR.admin, "POST", `/api/admin/users/${uidA}/reset-password`, { password: "パスワードだよん" });
    ok("全角は400", zenkaku.status === 400, `status=${zenkaku.status}`);

    // 自動生成 → 200 + 仮パスワード返却
    const gen = await api(JAR.admin, "POST", `/api/admin/users/${uidA}/reset-password`, { password: "" });
    ok("空指定で仮パスワード自動生成", gen.status === 200 && gen.data.generated === true && typeof gen.data.generatedPassword === "string" && gen.data.generatedPassword.length >= 8, `len=${gen.data.generatedPassword?.length}`);
    const oldLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: pwA });
    ok("旧パスワードではログイン不可", oldLogin.status === 401, `status=${oldLogin.status}`);
    const genLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: gen.data.generatedPassword });
    ok("仮パスワードでログイン可", genLogin.status === 200, `status=${genLogin.status}`);

    // 明示指定 → 200・generated=false・平文は返らない
    const explicit = await api(JAR.admin, "POST", `/api/admin/users/${uidA}/reset-password`, { password: pwReset });
    ok("明示パスワードで再設定", explicit.status === 200 && explicit.data.generated === false && explicit.data.generatedPassword === undefined, `status=${explicit.status}`);
    const newLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: pwReset });
    ok("新しいパスワードでログイン可", newLogin.status === 200, `status=${newLogin.status}`);

    // 監査ログ
    const logs = await api(JAR.admin, "GET", "/api/admin/audit-log");
    const actions = (logs.data.logs ?? []).map((l) => l.action);
    ok("監査ログにreset_passwordが記録", actions.includes("reset_password"), `n=${actions.filter((a) => a === "reset_password").length}`);
    ok("監査ログにpurge_registration_ipsが記録", actions.includes("purge_registration_ips"));

    // v10.1: JWTモードでも再設定後に既存トークンは即時失効する
    // （handleMeは無効セッションでもHTTP 200 + {user:null}を返す仕様）
    const meA = await api(JAR.a, "GET", "/api/auth/me");
    ok("JWTモードでも再設定後に即時失効（user:null）", meA.status === 200 && meA.data.user === null, `status=${meA.status} user=${meA.data.user}`);
  }

  console.log("=== 6) HMACモード: 再設定で即時失効 ===");
  {
    const switchMode = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "hmac" });
    ok("auth_mode=hmacへ切替", switchMode.status === 200 && switchMode.data.settings?.auth_mode === "hmac", `status=${switchMode.status}`);

    const reg = await api(JAR.c, "POST", "/api/auth/register", { email: emailC, password: pwC, username: `v10userC${ts % 100000}` });
    ok("ユーザーC登録（HMACセッション発行）", reg.status === 200, `status=${reg.status}`);
    ok("Cookieがsid_形式", (JAR.c.get("bbs_session") ?? "").startsWith("sid_"), `${(JAR.c.get("bbs_session") ?? "").slice(0, 8)}…`);
    const meBefore = await api(JAR.c, "GET", "/api/auth/me");
    ok("再設定前はログイン中", meBefore.status === 200, `status=${meBefore.status}`);

    const list = await api(JAR.admin, "GET", `/api/admin/users?q=${encodeURIComponent(emailC)}`);
    const uidC = list.data.users?.[0]?.user_id;
    const reset = await api(JAR.admin, "POST", `/api/admin/users/${uidC}/reset-password`, { password: pwReset });
    ok("Cのパスワード再設定", reset.status === 200, `status=${reset.status}`);

    const meAfter = await api(JAR.c, "GET", "/api/auth/me");
    // handleMeは無効セッションでもHTTP 200 + {user:null}を返す仕様
    ok("HMACモードでは再設定後に即時失効（user:null）", meAfter.status === 200 && meAfter.data.user === null, `status=${meAfter.status} user=${meAfter.data.user}`);

    const restore = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "jwt" });
    ok("auth_mode=jwtへ戻す", restore.status === 200 && restore.data.settings?.auth_mode === "jwt", `status=${restore.status}`);
  }

  console.log("=== 7) 利用規約ページ ===");
  {
    const res = await fetch(BASE + "/terms.html");
    const html = await res.text();
    ok("GET /terms.html が200", res.status === 200, `status=${res.status}`);
    ok("利用規約本文を含む", html.includes("利用規約") && html.includes("第1条"), "");
  }

  console.log("=== 8) サーバー自動削除伝播（集約レポート・server-removed同期） ===");
  {
    const list0 = await getServers();
    const urls0 = (list0.servers ?? []).map((s) => s.url);
    const FA = "https://fake-a.example.com";
    const FB = "https://fake-b.example.com";
    const FC = "https://fake-c.example.com";
    ok("シード済みfake-a/b/cが一覧に存在（deadDays付き）", urls0.includes(FA) && urls0.includes(FB) && urls0.includes(FC));
    const fa0 = (list0.servers ?? []).find((s) => s.url === FA);
    ok("fake-aの初期deadDays=2", fa0?.deadDays === 2, `deadDays=${fa0?.deadDays}`);

    // しきい値(3)到達 → 削除される
    const body1 = JSON.stringify({ senderUrl: "https://aggregator.example.com", checkedAt: Date.now(), aggregated: true, servers: [{ url: FA, name: "FA", type: "normal", health: "down", deadDays: 3 }] });
    const r1 = await api(null, "POST", "/api/sync/health-report", JSON.parse(body1), syncHeaders("POST", "/api/sync/health-report", body1));
    ok("集約レポート（deadDays=3）適用成功", r1.status === 200 && r1.data.ok === true, `status=${r1.status}`);
    const list1 = await getServers();
    ok("しきい値到達でfake-aが一覧から削除される", !(list1.servers ?? []).some((s) => s.url === FA));

    // しきい値未満 → 削除されずdeadDaysが反映される
    const body2 = JSON.stringify({ senderUrl: "https://aggregator.example.com", checkedAt: Date.now(), aggregated: true, servers: [{ url: FB, name: "FB", type: "normal", health: "down", deadDays: 2 }] });
    const r2 = await api(null, "POST", "/api/sync/health-report", JSON.parse(body2), syncHeaders("POST", "/api/sync/health-report", body2));
    ok("集約レポート（deadDays=2）適用成功", r2.status === 200, `status=${r2.status}`);
    const list2 = await getServers();
    const fb = (list2.servers ?? []).find((s) => s.url === FB);
    ok("しきい値未満は残りdeadDays=2が表示", !!fb && fb.deadDays === 2, `deadDays=${fb?.deadDays}`);

    // 単独報告（aggregated無し）では日数カウントを進めない
    const body3 = JSON.stringify({ senderUrl: "https://single-checker.example.com", checkedAt: Date.now(), servers: [{ url: FC, name: "FC", type: "normal", health: "down", deadDays: 99 }] });
    const r3 = await api(null, "POST", "/api/sync/health-report", JSON.parse(body3), syncHeaders("POST", "/api/sync/health-report", body3));
    ok("単独報告の適用成功", r3.status === 200, `status=${r3.status}`);
    const list3 = await getServers();
    const fc = (list3.servers ?? []).find((s) => s.url === FC);
    ok("単独報告ではdeadDaysを変更しない（0のまま）", !!fc && (fc.deadDays ?? 0) === 0, `deadDays=${fc?.deadDays}`);

    // server-removed同期（HMAC署名必須）
    const noSig = await api(null, "POST", "/api/sync/server-removed", { senderUrl: "https://aggregator.example.com", servers: [{ url: FB }] });
    ok("署名無しは401", noSig.status === 401, `status=${noSig.status}`);

    const body4 = JSON.stringify({ senderUrl: "https://aggregator.example.com", servers: [{ url: FB, deadDays: 3 }] });
    const r4 = await api(null, "POST", "/api/sync/server-removed", JSON.parse(body4), syncHeaders("POST", "/api/sync/server-removed", body4));
    ok("server-removed同期成功", r4.status === 200 && r4.data.removed >= 1, `status=${r4.status} removed=${r4.data.removed}`);
    const list4 = await getServers();
    ok("server-removed後は一覧から消える", !(list4.servers ?? []).some((s) => s.url === FB));

    // 後片代わりにfake-cもしきい値到達で削除
    const body5 = JSON.stringify({ senderUrl: "https://aggregator.example.com", checkedAt: Date.now(), aggregated: true, servers: [{ url: FC, name: "FC", type: "normal", health: "down", deadDays: 3 }] });
    await api(null, "POST", "/api/sync/health-report", JSON.parse(body5), syncHeaders("POST", "/api/sync/health-report", body5));
    const list5 = await getServers();
    ok("クリーンアップ: fake-cも削除", !(list5.servers ?? []).some((s) => s.url === FC));
  }

  console.log("");
  console.log(`結果: ${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("テスト実行エラー:", err);
  process.exit(1);
});
