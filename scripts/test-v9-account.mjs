#!/usr/bin/env node
// cf-bbs v9 ローカルE2Eテスト: 設定画面のアカウントセルフサービス機能
//   - パスワード変更（現在パスワード確認・他セッション失効・旧パスワード無効化）
//   - メールアドレス変更（重複拒否・/me の即時反映・再ログイン不要）
//   - アカウント削除（確認語・投稿匿名化・再登録解放・残存JWTの無効化）
//   - HMAC(D1セッション)モードでの即時失効
// 事前準備（ローカルD1へのシード。投稿間隔制限とTurnstileを無効化する）:
//   npx wrangler d1 execute DB_MAIN --local -y --command "INSERT INTO admin_settings (key, value, updated_at) VALUES ('require_turnstile_on_auth','false',1),('min_interval_new_sec','0',1) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
//   node scripts/create-admin.mjs --local --email v9-admin@test.local \
//             --password 'admin-pass-123' --username '管理人' --pepper test-pepper
// 使い方: node scripts/test-v9-account.mjs
const BASE = "http://127.0.0.1:8787";
const JAR = { admin: new Map(), a: new Map(), b: new Map(), c1: new Map(), c2: new Map(), x: new Map(), d: new Map() };

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

async function main() {
  const ts = Date.now() % 1000000;
  const pwA = "password-A1";
  const emailA = `v9-a-${ts}@example.com`;
  const emailA2 = `v9-a2-${ts}@example.com`;
  const unameA = `v9userA${ts}`;

  console.log("=== 0) 管理者ログイン（HMACモード切替の後技で使う） ===");
  {
    const r = await api(JAR.admin, "POST", "/api/auth/login", { email: "v9-admin@test.local", password: "admin-pass-123" });
    ok("管理者ログイン", r.status === 200 && r.data.user?.role === "admin", `status=${r.status}`);
  }

  console.log("=== 1) パスワード変更（JWTモード） ===");
  let threadIdOfA = 0;
  {
    const reg = await api(JAR.a, "POST", "/api/auth/register", { email: emailA, password: pwA, username: unameA });
    ok("ユーザーA登録", reg.status === 200, `status=${reg.status}`);
    const th = await api(JAR.a, "POST", "/api/threads", { title: "v9退会テスト用スレッド", body: "Aの最初の投稿" });
    ok("Aがスレッド作成", th.status === 201, `thread=${th.data.thread_id}`);
    threadIdOfA = th.data.thread_id;

    // 誤った現在パスワード → 401（旧パスワードは変更されない）
    const bad = await api(JAR.a, "POST", "/api/auth/password", { currentPassword: "wrong-pass-1", newPassword: "newpassword-B2" });
    ok("パス変更: 誤currentPasswordは401", bad.status === 401, `status=${bad.status}`);
    const relog1 = await api(null, "POST", "/api/auth/login", { email: emailA, password: pwA });
    ok("パス変更失敗後も旧パスでログイン可", relog1.status === 200, `status=${relog1.status}`);

    // 正しい変更 → 200 + 新しいCookie
    const jwtBefore = JAR.a.get("bbs_session");
    const good = await api(JAR.a, "POST", "/api/auth/password", { currentPassword: pwA, newPassword: "newpassword-B2" });
    ok("パス変更成功", good.status === 200 && good.data.ok === true, `status=${good.status}`);
    ok("パス変更で新しいセッションCookieが発行される", JAR.a.get("bbs_session") !== jwtBefore);
    const me = await api(JAR.a, "GET", "/api/auth/me");
    ok("パス変更後もこの端末はログイン維持", me.status === 200 && me.data.user?.email === emailA);

    const oldLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: pwA });
    ok("旧パスワードではログイン不可", oldLogin.status === 401, `status=${oldLogin.status}`);
    const newLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: "newpassword-B2" });
    ok("新パスワードでログイン可", newLogin.status === 200, `status=${newLogin.status}`);
  }

  console.log("=== 2) メールアドレス変更（JWTモード） ===");
  {
    const bad = await api(JAR.a, "PATCH", "/api/auth/email", { newEmail: emailA2, currentPassword: "nope-nope-1" });
    ok("メアド変更: 誤currentPasswordは401", bad.status === 401, `status=${bad.status}`);

    const same = await api(JAR.a, "PATCH", "/api/auth/email", { newEmail: emailA, currentPassword: "newpassword-B2" });
    ok("同一メアドは400", same.status === 400 && same.data.error?.code === "same_email", `status=${same.status}`);

    const invalid = await api(JAR.a, "PATCH", "/api/auth/email", { newEmail: "not-an-email", currentPassword: "newpassword-B2" });
    ok("形式不正は400", invalid.status === 400, `status=${invalid.status}`);

    const good = await api(JAR.a, "PATCH", "/api/auth/email", { newEmail: emailA2, currentPassword: "newpassword-B2" });
    ok("メアド変更成功", good.status === 200 && good.data.email === emailA2, `status=${good.status}`);

    const me = await api(JAR.a, "GET", "/api/auth/me");
    ok("/me が新しいメアドを即時返す（再ログイン不要）", me.status === 200 && me.data.user?.email === emailA2, `email=${me.data.user?.email}`);

    const oldEmailLogin = await api(null, "POST", "/api/auth/login", { email: emailA, password: "newpassword-B2" });
    ok("旧メアドではログイン不可", oldEmailLogin.status === 401, `status=${oldEmailLogin.status}`);
    const newEmailLogin = await api(null, "POST", "/api/auth/login", { email: emailA2.toUpperCase(), password: "newpassword-B2" });
    ok("新メアド（大文字混在・正規化）でログイン可", newEmailLogin.status === 200, `status=${newEmailLogin.status}`);
  }

  console.log("=== 3) メール重複チェック ===");
  {
    // ユーザーBを emailA2 と同じアドレスでは登録できない（登録APIは列挙防止の汎用エラー）
    const dupReg = await api(null, "POST", "/api/auth/register", { email: emailA2, password: "password-X9", username: `v9dup${ts}` });
    ok("使用中メアドでの新規登録は拒否", dupReg.status === 400, `status=${dupReg.status}`);

    // Bを別メアドで登録し、AがBのメアドへ変更しようとすると email_taken
    const emailB = `v9-b-${ts}@example.com`;
    const regB = await api(JAR.b, "POST", "/api/auth/register", { email: emailB, password: "password-B1", username: `v9userB${ts}` });
    ok("ユーザーB登録", regB.status === 200, `status=${regB.status}`);
    const taken = await api(JAR.a, "PATCH", "/api/auth/email", { newEmail: emailB, currentPassword: "newpassword-B2" });
    ok("他ユーザー使用中のメアドへの変更は400", taken.status === 400 && taken.data.error?.code === "email_taken", `status=${taken.status}`);
  }

  console.log("=== 4) アカウント削除（JWTモード・投稿匿名化・再登録解放） ===");
  {
    const noConfirm = await api(JAR.b, "POST", "/api/auth/delete-account", { currentPassword: "password-B1", confirm: "けす" });
    ok("確認語が違うと400", noConfirm.status === 400 && noConfirm.data.error?.code === "confirm_required", `status=${noConfirm.status}`);

    const badPw = await api(JAR.b, "POST", "/api/auth/delete-account", { currentPassword: "wrong-wrong-1", confirm: "削除" });
    ok("削除: 誤currentPasswordは401", badPw.status === 401, `status=${badPw.status}`);

    // 削除前の生セッション/CSRFを退避（残存JWTの挙動確認用）
    const staleCookie = `bbs_session=${JAR.b.get("bbs_session")}`;
    const staleCsrf = csrfOf(JAR.b);
    const emailB = `v9-b-${ts}@example.com`;

    const del = await api(JAR.b, "POST", "/api/auth/delete-account", { currentPassword: "password-B1", confirm: "削除" });
    ok("アカウント削除成功", del.status === 200 && del.data.ok === true, `status=${del.status}`);
    ok("削除応答でセッションCookieが消去される", (del.res.headers.getSetCookie?.() ?? []).some((c) => /Max-Age=0/.test(c)));

    // 残存JWTを抱えたリクエスト（jarではなく退避した生Cookieを使用）
    const staleMe = await fetch(BASE + "/api/auth/me", { headers: { Cookie: staleCookie } });
    const staleMeData = await staleMe.json();
    ok("残存JWTでの/meは未ログイン扱い", staleMe.status === 200 && staleMeData.user === null);
    const stalePost = await fetch(BASE + `/api/threads/${threadIdOfA}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE, Cookie: staleCookie, "X-CSRF-Token": staleCsrf },
      body: JSON.stringify({ body: "退会後の残存トークンからの投稿" }),
    });
    ok("残存JWT+CSRFでも投稿は403（DBでユーザー確認）", stalePost.status === 403, `status=${stalePost.status}`);

    // AのスレッドにBが返信しておく→匿名化を確認 … は削除後にはできないため、
    // 代わりにAのスレッド一覧とスレッド内投稿でBの痕跡が消えているか、
    // さらにBが削除前に残したものが無いことをスレッド状態で確認する。
    // （Bの返信は削除後に投稿不可のため、ここではAの投稿の匿名化をステップ5で確認）
    void emailB;

    // 同じメアド・ユーザー名での再登録が解放される
    const reReg = await api(null, "POST", "/api/auth/register", { email: emailB, password: "password-B1", username: `v9userB${ts}` });
    ok("退会後、同メアド+同ユーザー名で再登録できる", reReg.status === 200, `status=${reReg.status}`);
    // 再登録直後に旧セッションで操作するとユーザー不一致…は起きない（新ユーザーは別user_id）。
  }

  console.log("=== 5) 退会ユーザーAの削除と投稿の匿名化 ===");
  {
    // A自身が自分のスレッドに返信しておく（削除前）
    const reply = await api(JAR.a, "POST", `/api/threads/${threadIdOfA}/posts`, { body: "Aの返信（退会前）" });
    ok("Aが返信を作成", reply.status === 201, `status=${reply.status}`);

    const del = await api(JAR.a, "POST", "/api/auth/delete-account", { currentPassword: "newpassword-B2", confirm: "削除" });
    ok("ユーザーAのアカウント削除成功", del.status === 200, `status=${del.status}`);

    const me = await api(JAR.a, "GET", "/api/auth/me");
    ok("削除後の/meは未ログイン扱い", me.status === 200 && me.data.user === null);

    // スレッドは残る（他の人のコンテンツを守るため）。投稿の表示名は空（→名無しさん表示）
    const list = await api(null, "GET", `/api/threads/${threadIdOfA}/posts`);
    const posts = list.data.posts ?? [];
    ok("スレッド・投稿は残存する", list.status === 200 && posts.length === 2, `posts=${posts.length}`);
    ok("退会者の投稿表示名は空文字（フロントで名無しさん表示）", posts.every((p) => p.username === ""), JSON.stringify(posts.map((p) => p.username)));
    // キャッシュバスター付きで取得（miniflareはCache APIを永続化するため、
    // 同一URLの過去 runs のキャッシュがdev再起動後も返ることがある）
    const thread = (await api(null, "GET", `/api/threads?cb=${Date.now()}`)).data.threads?.find((t) => t.thread_id === threadIdOfA);
    ok("スレッド一覧の作成名も空文字", thread !== undefined && thread.username === "", `username=${thread?.username}`);

    const reRegA = await api(null, "POST", "/api/auth/register", { email: emailA2, password: "password-Z9", username: unameA });
    ok("退会後、Aのメアド・ユーザー名で再登録できる", reRegA.status === 200, `status=${reRegA.status}`);
  }

  console.log("=== 6) HMAC(D1セッション)モード: パス変更・退会で即時失効 ===");
  {
    const setMode = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "hmac" });
    ok("auth_mode=hmacへ切替", setMode.status === 200, `status=${setMode.status}`);

    const emailC = `v9-c-${ts}@example.com`;
    const reg = await api(JAR.x, "POST", "/api/auth/register", { email: emailC, password: "password-C1", username: `v9userC${ts}` });
    ok("ユーザーC登録", reg.status === 200, `status=${reg.status}`);
    ok("HMACモードではsid_セッションが発行される", (JAR.x.get("bbs_session") ?? "").startsWith("sid_"), JAR.x.get("bbs_session")?.slice(0, 8));
    // regレスポンスのCookieはJAR.xに入っている。Cの2セッション構成を作る
    JAR.c1.clear(); for (const [k, v] of JAR.x) JAR.c1.set(k, v);
    JAR.c2.clear();
    const login2 = await api(JAR.c2, "POST", "/api/auth/login", { email: emailC, password: "password-C1" });
    ok("Cが2台目でログイン", login2.status === 200, `status=${login2.status}`);

    // 1台目でパスワード変更 → 2台目は即時失効、1台目は継続
    const chg = await api(JAR.c1, "POST", "/api/auth/password", { currentPassword: "password-C1", newPassword: "password-C2" });
    ok("（HMAC）パス変更成功", chg.status === 200, `status=${chg.status}`);
    const me1 = await api(JAR.c1, "GET", "/api/auth/me");
    ok("（HMAC）変更した端末は新セッションで継続", me1.status === 200 && me1.data.user?.email === emailC);
    const me2 = await api(JAR.c2, "GET", "/api/auth/me");
    ok("（HMAC）他端末のセッションは即時失効", me2.status === 200 && me2.data.user === null);

    // メール変更（HMACモード）
    const emailC2 = `v9-c2-${ts}@example.com`;
    const em = await api(JAR.c1, "PATCH", "/api/auth/email", { newEmail: emailC2, currentPassword: "password-C2" });
    ok("（HMAC）メアド変更成功", em.status === 200, `status=${em.status}`);
    const me3 = await api(JAR.c1, "GET", "/api/auth/me");
    ok("（HMAC）/meが新しいメアドを返す", me3.status === 200 && me3.data.user?.email === emailC2);

    // 退会（HMACモード）→ 現セッションも即時失効
    const del = await api(JAR.c1, "POST", "/api/auth/delete-account", { currentPassword: "password-C2", confirm: "削除" });
    ok("（HMAC）アカウント削除成功", del.status === 200, `status=${del.status}`);
    const me4 = await api(JAR.c1, "GET", "/api/auth/me");
    ok("（HMAC）削除後はセッション失効で未ログイン", me4.status === 200 && me4.data.user === null);

    const back = await api(JAR.admin, "PUT", "/api/admin/settings", { auth_mode: "jwt" });
    ok("auth_mode=jwtへ復元", back.status === 200, `status=${back.status}`);
  }

  console.log("=== 7) パスワード照合の連続失敗ロック（AuthGuard） ===");
  {
    // 専用ユーザーDで現在パスワードを8回連続で間違える → 9回目は429
    // （ログインと同じAUTH_MAX_FAILURES=8のロック。IP/メール単位で効く）
    const emailD = `v9-d-${ts}@example.com`;
    const reg = await api(JAR.d, "POST", "/api/auth/register", { email: emailD, password: "password-D1", username: `v9userD${ts}` });
    ok("ユーザーD登録", reg.status === 200, `status=${reg.status}`);
    let last = 0;
    for (let i = 1; i <= 8; i++) {
      const r = await api(JAR.d, "POST", "/api/auth/password", { currentPassword: `wrong-${i}-xxxx`, newPassword: "password-D2" });
      last = r.status;
      if (r.status !== 401) break;
    }
    ok("8回の連続失敗は401", last === 401, `last=${last}`);
    const ninth = await api(JAR.d, "POST", "/api/auth/password", { currentPassword: "wrong-9-xxxx", newPassword: "password-D2" });
    ok("9回目はレート制限で429", ninth.status === 429, `status=${ninth.status}`);
  }

  console.log(`\n結果: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("テスト実行エラー:", err);
  process.exit(1);
});
