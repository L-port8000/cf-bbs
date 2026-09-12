import { ApiError, type AdminSettings, type Env, type SessionRecord, type UserRecord } from "../types";
import { hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from "../utils/crypto";
import { getAdminSettings } from "../utils/settings";
import { verifyTurnstileDetailed, turnstileUserMessage } from "../utils/turnstile";
import { graphemeLength } from "../utils/segmenter";
import {
  getUserByEmail,
  getUserById,
  getUserByUsername,
  insertUser,
  recordLoginDay,
  countDistinctLoginDays,
  promoteUserToRegular,
  setUsername,
  countUsernameChangesOnDay,
  recordUsernameChange,
  updateUserEmail,
  updateUserPassword,
  updateD1SessionsEmailForUser,
  deleteD1SessionsForUser,
  deleteUserById,
  deleteLoginDaysForUser,
  deleteUsernameChangeCountsForUser,
  anonymizeUserPosts,
  anonymizeUserThreads,
  insertApiKey,
  listApiKeysForUser,
  countApiKeysForUser,
  deleteApiKey,
  insertAuditLog,
  type ApiKeyRow,
} from "../db/queries";
import { issueSessionToken, revokeSession, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "../middleware/session";
import { issueCsrfToken, CSRF_COOKIE_NAME } from "../middleware/csrf";
import { guardAuthAttempt, getClientIp } from "../middleware/rateLimit";
import { API_KEY_PREFIX, assertSessionNotRevoked, getSessionFromRequest, requireCsrf, requireSession, requireValidOrigin } from "../middleware/auth";
import { buildSessionCookie, jsonResponse, parseCookies } from "../utils/response";
import { requireJsonContentType, requireContentLengthWithin } from "../middleware/auth";

const MAX_AUTH_BODY_BYTES = 4096;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// メールアドレス・パスワードは半角（ASCII印字可能文字）のみ許可する。
// 全角文字・日本語・絵文字等が混入すると入力ミスに気づきにくく、
// ログイン失敗の原因になるため入力段階で排除する（要望仕様）。
const ASCII_PRINTABLE_REGEX = /^[\x20-\x7E]+$/;
// ユーザー名に使える文字: 日本語・英数字・アンダースコア・中点程度に絞り、
// 制御文字やHTML的に危険な記号（<>"'&等）は許可しない（保存時はプレーン
// テキストとして扱い出力時にエスケープする方針だが、表示名は多用途に
// 埋め込まれるため入力段階でも安全な文字種に制限しておく）。
const USERNAME_REGEX = /^[\p{L}\p{N}_ー・\-]+$/u;

interface AuthBody {
  email?: string;
  password?: string;
  username?: string;
  turnstileToken?: string;
  // 設定画面（メール変更・パスワード変更・退会）で使う追加フィールド
  currentPassword?: string;
  newPassword?: string;
  newEmail?: string;
  confirm?: string;
  // APIキー発行（v11: 設定「高度な機能」）で使う追加フィールド
  label?: string;
}

async function readAuthBody(request: Request): Promise<AuthBody> {
  requireJsonContentType(request);
  requireContentLengthWithin(request, MAX_AUTH_BODY_BYTES);
  const text = await request.text();
  if (text.length > MAX_AUTH_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  }
  try {
    return JSON.parse(text) as AuthBody;
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
}

function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function validateUsername(settings: AdminSettings, username: string): void {
  const len = graphemeLength(username);
  if (len < settings.username_min_len || len > settings.username_max_len) {
    throw new ApiError(
      400,
      "invalid_username",
      `ユーザー名は${settings.username_min_len}〜${settings.username_max_len}文字で入力してください`
    );
  }
  if (!USERNAME_REGEX.test(username)) {
    throw new ApiError(400, "invalid_username", "ユーザー名に使用できない文字が含まれています");
  }
}

// ログイン/登録時にHttpOnly CookieへJWTを、非HttpOnly CookieへCSRFトークンを発行する。
// v2(JWT化)によりセッションストア(KV/D1)への書き込みは発生しない。
function setAuthCookies(env: Env, headers: Headers, token: string, csrfToken: string): void {
  const domain = env.COOKIE_DOMAIN || undefined;
  headers.append(
    "Set-Cookie",
    buildSessionCookie(SESSION_COOKIE_NAME, token, { maxAgeSeconds: SESSION_TTL_SECONDS, domain })
  );
  // CSRFトークンは非HttpOnly（JSが読み取ってヘッダへ載せるため）だが、
  // Secure / SameSite=Lax は引き続き付与する。値自体はHMAC署名済みなので
  // 漏えいしてもsession_id(HttpOnly)無しには意味を持たない。
  const domainPart = domain ? ` Domain=${domain};` : "";
  headers.append(
    "Set-Cookie",
    `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/;${domainPart} Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

export async function handleRegister(env: Env, request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const body = await readAuthBody(request);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const username = (body.username ?? "").trim();

  if (!EMAIL_REGEX.test(email) || email.length > 254 || !ASCII_PRINTABLE_REGEX.test(email)) {
    throw new ApiError(400, "invalid_email", "メールアドレスは半角英数記号で正しく入力してください");
  }
  const settings = await getAdminSettings(env);
  if (username.length > 0) {
    validateUsername(settings, username);
  }

  // パスワードは8文字〜password_max_len（既定20文字・管理画面で変更可）。
  // ログイン時には最大長をチェックしない（既存ユーザーの締め出し防止）。
  if (password.length < 8 || password.length > settings.password_max_len) {
    throw new ApiError(400, "weak_password", `パスワードは8文字以上${settings.password_max_len}文字以下にしてください`);
  }
  if (!ASCII_PRINTABLE_REGEX.test(password)) {
    throw new ApiError(400, "weak_password", "パスワードは半角文字のみ使用できます（全角・日本語は入力できません）");
  }

  const guard = await guardAuthAttempt(env, ip, email);
  if (!guard.allowed) {
    throw new ApiError(429, "rate_limited", "試行回数が多すぎます。しばらくしてから再度お試しください");
  }

  if (settings.require_turnstile_on_auth) {
    const result = await verifyTurnstileDetailed(env, body.turnstileToken, ip);
    if (!result.ok) {
      await guard.recordResult(false);
      // 失敗理由（期限切れ・使用済み・未取得など）に応じた案内を出す。
      // フロントエンドは失敗後にウィジェットをリセットして新しいトークンを
      // 取得するため、ユーザーはそのまま再試行できる
      throw new ApiError(400, "turnstile_failed", turnstileUserMessage(result.errors));
    }
  }

  const existing = await getUserByEmail(env.DB_MAIN, email);
  if (existing) {
    await guard.recordResult(false);
    // ユーザー列挙対策: 「既に登録済み」であることを明示しない汎用エラー。
    throw new ApiError(400, "registration_failed", "この内容では登録できませんでした");
  }

  if (username.length > 0) {
    const usernameTaken = await getUserByUsername(env.DB_MAIN, username);
    if (usernameTaken) {
      await guard.recordResult(false);
      throw new ApiError(400, "username_taken", "そのユーザー名は既に使われています");
    }
  }

  const now = Date.now();
  const { hash, salt, iterations } = await hashPassword(password, env.PASSWORD_PEPPER);
  const isBootstrapAdmin = env.BOOTSTRAP_ADMIN_EMAIL !== "" && email === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();

  const user: UserRecord = {
    user_id: randomId(16),
    email,
    username: username.length > 0 ? username : null,
    password_hash: hash,
    password_salt: salt,
    password_iterations: iterations,
    role: isBootstrapAdmin ? "admin" : "user",
    tier: "new",
    status: "active",
    ban_reason: null,
    created_at: now,
    updated_at: now,
    // 登録時IPは管理設定（record_registration_ip）がONのときのみ保存する（既定OFF）。
    // CF-Connecting-IPはCloudflareが付与する値のため最大64文字に制限して保存。
    registration_ip: settings.record_registration_ip ? ip.slice(0, 64) : null,
  };

  await insertUser(env.DB_MAIN, user);
  await recordLoginDay(env.DB_MAIN, user.user_id, utcDayKey(now));
  await guard.recordResult(true);

  // JWT発行（ストレージ消費ゼロ）。csrfTokenはjtiのHMAC。
  const { token, sessionId } = await issueSessionToken(env, user.user_id, user.email, user.role);
  const csrfToken = await issueCsrfToken(env, sessionId);

  const headers = new Headers();
  setAuthCookies(env, headers, token, csrfToken);

  return jsonResponse(
    {
      user: { user_id: user.user_id, email: user.email, username: user.username, role: user.role, tier: user.tier },
      csrfToken,
    },
    { headers }
  );
}

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const body = await readAuthBody(request);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!EMAIL_REGEX.test(email) || password.length === 0) {
    throw new ApiError(400, "invalid_credentials", "メールアドレスまたはパスワードが正しくありません");
  }

  const guard = await guardAuthAttempt(env, ip, email);
  if (!guard.allowed) {
    throw new ApiError(429, "rate_limited", "試行回数が多すぎます。しばらくしてから再度お試しください");
  }

  const settings = await getAdminSettings(env);
  if (settings.require_turnstile_on_auth) {
    const result = await verifyTurnstileDetailed(env, body.turnstileToken, ip);
    if (!result.ok) {
      await guard.recordResult(false);
      throw new ApiError(400, "turnstile_failed", turnstileUserMessage(result.errors));
    }
  }

  const user = await getUserByEmail(env.DB_MAIN, email);
  if (!user) {
    await guard.recordResult(false);
    throw new ApiError(401, "invalid_credentials", "メールアドレスまたはパスワードが正しくありません");
  }

  const validPassword = await verifyPassword(
    password,
    env.PASSWORD_PEPPER,
    user.password_salt,
    user.password_iterations,
    user.password_hash
  );

  if (!validPassword) {
    await guard.recordResult(false);
    throw new ApiError(401, "invalid_credentials", "メールアドレスまたはパスワードが正しくありません");
  }

  if (user.status === "banned") {
    await guard.recordResult(true); // 資格情報自体は正しいため成功扱いでロックは解除する
    throw new ApiError(403, "banned", user.ban_reason ? `アカウントが停止されています: ${user.ban_reason}` : "アカウントが停止されています");
  }

  await guard.recordResult(true);

  const now = Date.now();
  const isNewLoginDay = await recordLoginDay(env.DB_MAIN, user.user_id, utcDayKey(now));
  if (isNewLoginDay && user.tier === "new") {
    const distinctDays = await countDistinctLoginDays(env.DB_MAIN, user.user_id);
    if (distinctDays >= settings.promotion_distinct_days) {
      await promoteUserToRegular(env.DB_MAIN, user.user_id, now);
    }
  }

  // JWT発行（ストレージ消費ゼロ）。csrfTokenはjtiのHMAC。
  const { token, sessionId } = await issueSessionToken(env, user.user_id, user.email, user.role);
  const csrfToken = await issueCsrfToken(env, sessionId);

  const headers = new Headers();
  setAuthCookies(env, headers, token, csrfToken);

  const freshUser = await getUserByEmail(env.DB_MAIN, email);

  return jsonResponse(
    {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: freshUser?.username ?? user.username,
        role: user.role,
        tier: freshUser?.tier ?? user.tier,
      },
      csrfToken,
    },
    { headers }
  );
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  // HMACモード(D1セッション)では即時失効のためセッション行を削除する。
  // JWTモードでは失効できないためCookie削除のみ（KV/D1へのアクセスは
  // HMACモードの1 DELETE以外発生しない）。
  const cookies = parseCookies(request.headers.get("Cookie"));
  await revokeSession(env, cookies[SESSION_COOKIE_NAME]);

  const domain = env.COOKIE_DOMAIN || undefined;
  const headers = new Headers();
  headers.append("Set-Cookie", buildSessionCookie(SESSION_COOKIE_NAME, "", { expiresImmediately: true, domain }));
  const domainPart = domain ? ` Domain=${domain};` : "";
  headers.append("Set-Cookie", `${CSRF_COOKIE_NAME}=;${domainPart} Path=/; Secure; SameSite=Lax; Max-Age=0`);
  return jsonResponse({ ok: true }, { headers });
}

export async function handleMe(env: Env, request: Request): Promise<Response> {
  const session = await getSessionFromRequest(env, request);
  if (!session) {
    return jsonResponse({ user: null });
  }
  const csrfToken = await issueCsrfToken(env, session.session_id);
  const user = await getUserById(env.DB_MAIN, session.user_id);
  if (!user) {
    // 退会済み（users行が削除済み）のセッションは未ログイン扱いにする。
    // JWTモードで残存する古いトークンもここで無効化される
    // （HMACモードは退会時にd1_sessionsごと削除済みのため通常ここに到達しない）。
    return jsonResponse({ user: null });
  }
  // パスワード変更で失効した古いセッションも未ログイン扱いにする（0007）。
  // これにより他端末は次回ページ表示時に自動でログアウト状態へ戻る。
  if (user.sessions_invalidated_at != null && session.created_at < user.sessions_invalidated_at * 1000) {
    return jsonResponse({ user: null });
  }
  return jsonResponse({
    user: {
      user_id: session.user_id,
      // メールは常にDB値を優先する（JWTモードでメール変更後もトークンの
      // emailクレームは古い値のまま残るため。表示・動作への影響をなくす）。
      email: user.email,
      username: user.username ?? null,
      role: session.role,
      tier: user.tier,
    },
    csrfToken,
  });
}

// PATCH /api/auth/username — ログイン後にユーザー名を設定・変更する。
// 悪用（頻繁な改名によるなりすまし混乱等）を防ぐため、1日あたりの変更回数
// 上限（既定5回/日・管理画面から変更可能）を設ける。成功した変更のみを
// UTC日付ごとにDB_MAINへカウントする（マイグレーション0003参照）。
export async function handleUpdateUsername(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readAuthBody(request);
  const username = (body.username ?? "").trim();
  if (username.length === 0) {
    throw new ApiError(400, "invalid_username", "ユーザー名を入力してください");
  }

  const settings = await getAdminSettings(env);
  validateUsername(settings, username);

  // 失効セッション（パスワード変更済みの古いトークン）による改名も防ぐ（0007）
  const me = await getUserById(env.DB_MAIN, session.user_id);
  if (!me || me.status === "banned") {
    throw new ApiError(403, "forbidden", "アカウント操作の権限がありません");
  }
  assertSessionNotRevoked(session, me);

  const dayKey = utcDayKey(Date.now());
  const usedToday = await countUsernameChangesOnDay(env.DB_MAIN, session.user_id, dayKey);
  if (usedToday >= settings.username_daily_change_limit) {
    throw new ApiError(
      429,
      "username_change_limit",
      `1日あたりの変更回数上限（${settings.username_daily_change_limit}回）に達しました。翌日以降にお試しください`
    );
  }

  const existing = await getUserByUsername(env.DB_MAIN, username);
  if (existing && existing.user_id !== session.user_id) {
    throw new ApiError(400, "username_taken", "そのユーザー名は既に使われています");
  }

  const ok = await setUsername(env.DB_MAIN, session.user_id, username, Date.now());
  if (!ok) {
    throw new ApiError(400, "username_taken", "そのユーザー名は既に使われています");
  }

  // 成功した変更のみカウントする（失敗した試行は消費しない）
  await recordUsernameChange(env.DB_MAIN, session.user_id, dayKey);

  return jsonResponse({ username, changesToday: usedToday + 1 });
}

// ---------------------------------------------------------------------------
// アカウントセルフサービス（設定画面）— メール変更 / パスワード変更 / 退会
//
// 共通設計:
// - Origin検証 + ログイン必須 + CSRF検証に加え、必ず「現在のパスワード」の
//   再入力を要求する（離席中の端末での勝手な変更・退会、Cookie盗用時の被害限定）。
// - パスワード照合の総当たり対策として、ログインと同じ AuthGuard
//   （IP+メール単位の連続失敗ロック・Cache API・課金対象外）を適用する。
// - Turnstileは要求しない（ログイン済み+CSRF+パスワード再検証で十分ため、
//   余計な摩擦を入れない）。
// ---------------------------------------------------------------------------

// 現在のパスワードを検証する共通ヘルパー。失敗時はAuthGuardに失敗を記録し401を返す。
async function verifyCurrentPassword(env: Env, request: Request, user: UserRecord, currentPassword: string): Promise<void> {
  const guard = await guardAuthAttempt(env, getClientIp(request), user.email);
  if (!guard.allowed) {
    throw new ApiError(429, "rate_limited", "試行回数が多すぎます。しばらくしてから再度お試しください");
  }
  const ok = await verifyPassword(
    currentPassword,
    env.PASSWORD_PEPPER,
    user.password_salt,
    user.password_iterations,
    user.password_hash
  );
  if (!ok) {
    await guard.recordResult(false);
    throw new ApiError(401, "invalid_credentials", "現在のパスワードが正しくありません");
  }
  await guard.recordResult(true);
}

function validateNewPassword(settings: AdminSettings, password: string): void {
  if (password.length < 8 || password.length > settings.password_max_len) {
    throw new ApiError(400, "weak_password", `パスワードは8文字以上${settings.password_max_len}文字以下にしてください`);
  }
  if (!ASCII_PRINTABLE_REGEX.test(password)) {
    throw new ApiError(400, "weak_password", "パスワードは半角文字のみ使用できます（全角・日本語は入力できません）");
  }
}

// セッション主体が保護された操作（アカウント変更系）を行える状態か確認する。
// 退会済み（users行が無い）・BAN済み・パスワード変更で失効した古いセッション
// （0007: iat < sessions_invalidated_at）による操作を防ぐ。
async function getOperableUser(env: Env, session: SessionRecord, userId: string): Promise<UserRecord> {
  const user = await getUserById(env.DB_MAIN, userId);
  if (!user || user.status === "banned") {
    throw new ApiError(403, "forbidden", "アカウント操作の権限がありません");
  }
  assertSessionNotRevoked(session, user);
  return user;
}

// PATCH /api/auth/email — メールアドレス変更。
// 現在のパスワード確認後、users.email を更新する（UNIQUE制約により重複不可）。
// セッションは継続（再ログイン不要）。/api/auth/me が常にDB値のemailを返すため、
// JWT/HMACどちらのモードでも表示は即座に新しいメールへ切り替わる。
export async function handleUpdateEmail(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readAuthBody(request);
  const currentPassword = body.currentPassword ?? "";
  const newEmail = (body.newEmail ?? "").trim().toLowerCase();
  if (!EMAIL_REGEX.test(newEmail) || newEmail.length > 254 || !ASCII_PRINTABLE_REGEX.test(newEmail)) {
    throw new ApiError(400, "invalid_email", "メールアドレスは半角英数記号で正しく入力してください");
  }

  const user = await getOperableUser(env, session, session.user_id);
  if (newEmail === user.email) {
    throw new ApiError(400, "same_email", "現在のメールアドレスと同じです。新しいアドレスを入力してください");
  }

  await verifyCurrentPassword(env, request, user, currentPassword);

  const ok = await updateUserEmail(env.DB_MAIN, user.user_id, newEmail, Date.now());
  if (!ok) {
    // 事前チェックとUNIQUE制約の二重防御（レース時はこちらで拾う）
    throw new ApiError(400, "email_taken", "このメールアドレスは既に使用されています");
  }

  // HMACモードのセッション行のemailも更新（表示は/meのDB値優先だが整合性のため）。
  // JWTモードのemailクレームは古いまま残るが/meがDB値を返すため影響なし。
  await updateD1SessionsEmailForUser(env.DB_MAIN, user.user_id, newEmail);

  return jsonResponse({ ok: true, email: newEmail });
}

// POST /api/auth/password — パスワード変更。
// 現在のパスワード確認後、新しいソルトでPBKDF2ハッシュを再生成して保存する。
// セッションの取り扱い（JWT/HMAC両モードで即時失効・0007マイグレーション）:
// - updateUserPassword が users.sessions_invalidated_at へ変更時刻を記録する
// - それ以前に発行された全セッション（他端末のJWT/SID）は、書き込み系APIの
//   失効チェック（assertSessionNotRevoked）で401になり、/me でも未ログイン扱い
// - その後この端末用に新しいセッション（JWT or sid_）を発行し直すため、
//   現在操作中の端末はログインしたまま次の操作へ進める
export async function handleChangePassword(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readAuthBody(request);
  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";

  const user = await getOperableUser(env, session, session.user_id);

  // 新パスワードは登録時と同じ基準で検証する（現行より長い既存パスワードの
  // ユーザーは「変更しない」選択をしているため、変更時のみ新基準を適用してよい）
  const settings = await getAdminSettings(env);
  validateNewPassword(settings, newPassword);

  await verifyCurrentPassword(env, request, user, currentPassword);

  const now = Date.now();
  const { hash, salt, iterations } = await hashPassword(newPassword, env.PASSWORD_PEPPER);
  await updateUserPassword(env.DB_MAIN, user.user_id, hash, salt, iterations, now);

  // 他端末のセッション失効（HMACモード）+ この端末用の新セッション発行
  await deleteD1SessionsForUser(env.DB_MAIN, user.user_id);
  const { token, sessionId } = await issueSessionToken(env, user.user_id, user.email, user.role);
  const csrfToken = await issueCsrfToken(env, sessionId);

  const headers = new Headers();
  setAuthCookies(env, headers, token, csrfToken);
  return jsonResponse({ ok: true, csrfToken }, { headers });
}

// POST /api/auth/delete-account — アカウント削除（退会）。
// 挙動（README参照）:
// - 投稿・スレッドは残す（他の人の返信を含むスレッドを消すと共有コンテンツが
//   失われるため）が、表示名を空にして「名無しさん」として表示される
// - users / user_login_days / username_change_counts / d1_sessions の本人の行を削除
// - 退会後は同じメールアドレス・ユーザー名での再登録が可能（一意管理はusers表のみ）
// - 誤操作防止のため「削除」という確認語の入力+現在のパスワードを要求する
export async function handleDeleteAccount(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readAuthBody(request);
  const currentPassword = body.currentPassword ?? "";
  const confirm = (body.confirm ?? "").trim();
  if (confirm !== "削除") {
    throw new ApiError(400, "confirm_required", "確認のため「削除」と入力してください");
  }

  const user = await getOperableUser(env, session, session.user_id);

  await verifyCurrentPassword(env, request, user, currentPassword);

  // 1) 投稿・スレッドの表示名を匿名化（DB_MAIN / shard1 / shard2 の全D1が対象。
  //    db_shard_count 設定に関わらず全DBへ実行する——過去の移行でシャードに
  //    落ちた投稿も確実に拾うため。空UPDATEのコストはほぼゼロ）
  for (const db of [env.DB_MAIN, env.DB_SHARD_1, env.DB_SHARD_2]) {
    await anonymizeUserPosts(db, user.user_id);
    await anonymizeUserThreads(db, user.user_id);
  }

  // 2) 本人の行を一括削除（D1 batchは同DB内でアトミック）。APIキーも併せて失効
  await env.DB_MAIN.batch([
    env.DB_MAIN.prepare("DELETE FROM user_login_days WHERE user_id = ?").bind(user.user_id),
    env.DB_MAIN.prepare("DELETE FROM username_change_counts WHERE user_id = ?").bind(user.user_id),
    env.DB_MAIN.prepare("DELETE FROM d1_sessions WHERE user_id = ?").bind(user.user_id),
    env.DB_MAIN.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(user.user_id),
    env.DB_MAIN.prepare("DELETE FROM users WHERE user_id = ?").bind(user.user_id),
  ]);

  // 3) Cookieを削除してログアウト状態へ（HMACセッションは2)で失効済み。
  //    JWTモードの残存トークンは /me がユーザー行無しを検出して未ログイン扱いにする）
  const domain = env.COOKIE_DOMAIN || undefined;
  const headers = new Headers();
  headers.append("Set-Cookie", buildSessionCookie(SESSION_COOKIE_NAME, "", { expiresImmediately: true, domain }));
  const domainPart = domain ? ` Domain=${domain};` : "";
  headers.append("Set-Cookie", `${CSRF_COOKIE_NAME}=;${domainPart} Path=/; Secure; SameSite=Lax; Max-Age=0`);
  return jsonResponse({ ok: true }, { headers });
}

// ---------------------------------------------------------------------------
// APIキー管理（v11新設・設定画面「高度な機能」から呼ばれる）
//
// - 一覧/発行/失効は「ブラウザログイン（Cookie + CSRF + Origin検証）」でのみ可能。
//   APIキー（Bearer）でのAPIキー管理は禁止する（漏えいしたキーが新しいキーを
//   発行して自立増殖できないようにするため）。
// - キー本体は平文保存せずSHA-256ハッシュのみ保存。全文は発行時のレスポンスで
//   一度だけ返す（以後はkey_prefix＝先頭12文字のみ表示）。
// - 発行・失効は監査ログ（audit_log）へ記録する。
// - これらのエンドポイント自体は書き込み系相当のため requireValidOrigin による
//   外部ツール拒否の対象（GET一覧は実質ブラウザ専用UIからのみ呼ばれる）。
// ---------------------------------------------------------------------------

const MAX_API_KEYS_PER_USER = 10;
const API_KEY_LABEL_MAX = 30;

// APIキーによる操作を拒否する共通ガード（管理系はブラウザログイン限定）
function requireCookieSession(session: SessionRecord): void {
  if (session.authVia === "apikey") {
    throw new ApiError(403, "api_key_management_forbidden", "APIキーの管理はブラウザからログインして行ってください");
  }
}

function toApiKeyJson(row: ApiKeyRow) {
  return {
    key_id: row.key_id,
    label: row.label,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

// GET /api/auth/api-keys — 登録済みキーの一覧（全文は返さない）
export async function handleListApiKeys(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  requireCookieSession(session);

  const rows = await listApiKeysForUser(env.DB_MAIN, session.user_id);
  return jsonResponse({ keys: rows.map(toApiKeyJson) });
}

// POST /api/auth/api-keys — 新規発行 {label} → 全文（key）はこの応答で一度だけ返す
export async function handleCreateApiKey(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);
  requireCookieSession(session);

  const body = await readAuthBody(request);
  const label = (body.label ?? "").trim().slice(0, API_KEY_LABEL_MAX);
  if (label.length === 0) {
    throw new ApiError(400, "invalid_label", `キーの名前（用途など）を1〜${API_KEY_LABEL_MAX}文字で入力してください`);
  }

  // 失効セッション・BAN済みユーザーによる発行を防ぐ（他のアカウント操作と同じ基準）
  const me = await getUserById(env.DB_MAIN, session.user_id);
  if (!me || me.status === "banned") {
    throw new ApiError(403, "forbidden", "APIキーを発行する権限がありません");
  }
  assertSessionNotRevoked(session, me);

  const existing = await countApiKeysForUser(env.DB_MAIN, session.user_id);
  if (existing >= MAX_API_KEYS_PER_USER) {
    throw new ApiError(
      400,
      "api_key_limit",
      `APIキーは1アカウント${MAX_API_KEYS_PER_USER}本までです。使わないキーを失効させてください`
    );
  }

  const now = Date.now();
  const rawKey = `${API_KEY_PREFIX}${randomToken(32)}`;
  const row: ApiKeyRow = {
    key_id: `ak_${randomToken(12)}`,
    user_id: session.user_id,
    key_hash: await sha256Hex(rawKey),
    label,
    key_prefix: rawKey.slice(0, API_KEY_PREFIX.length + 8),
    created_at: now,
    last_used_at: null,
  };
  await insertApiKey(env.DB_MAIN, row);
  await insertAuditLog(env.DB_MAIN, session.user_id, "api_key_create", row.key_id, JSON.stringify({ label }), now);

  return jsonResponse({ ...toApiKeyJson(row), key: rawKey }, { status: 201 });
}

// DELETE /api/auth/api-keys/:keyId — 失効（＝行削除。即時・復元不可）
export async function handleRevokeApiKey(env: Env, request: Request, keyId: string): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);
  requireCookieSession(session);

  const ok = await deleteApiKey(env.DB_MAIN, keyId, session.user_id);
  if (!ok) {
    throw new ApiError(404, "not_found", "指定されたAPIキーが見つかりません");
  }
  await insertAuditLog(env.DB_MAIN, session.user_id, "api_key_revoke", keyId, null, Date.now());
  return jsonResponse({ ok: true });
}
