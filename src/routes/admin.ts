import { ApiError, type Env, type SessionRecord } from "../types";
import {
  searchUsers,
  setUserBanStatus,
  setUserRole,
  getUserById,
  getThread,
  setPostStatus,
  setThreadStatus,
  insertAuditLog,
  listAuditLog,
  countUsers,
  countVisibleThreads,
  countAuditLogSince,
  countKnownServers,
  countPostsInThread,
  adminListThreads,
  updateUserPassword,
  deleteD1SessionsForUser,
  clearRegistrationIps,
} from "../db/queries";
import { getShardDb, getThreadShard, migrateOldThreads, deleteExpiredThreads, deleteExpiredThreadsInMain, deleteManifestEntry } from "../db/sharding";
import { getAdminSettings, setAdminSetting } from "../utils/settings";
import { jsonResponse } from "../utils/response";
import { assertSessionNotRevoked, requireAdmin, requireCsrf, requireSession, requireValidOrigin, requireJsonContentType } from "../middleware/auth";
import { hashPassword, randomToken, timingSafeEqualStr } from "../utils/crypto";

async function readJson<T>(request: Request): Promise<T> {
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 65536) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
}

async function requireAdminSession(env: Env, request: Request): Promise<SessionRecord> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  requireAdmin(session);
  // 管理者自身のユーザー行も確認する（0007）。roleはJWTクレーム（ログイン時点の
  // スナップショット）のため、これだけでは「BANされた管理者」「パスワード変更後に
  // 失効した古いトークン」を防げない。管理API呼び出しは頻度が低いので
  // +1 readは許容（BANされた管理者による後続の管理操作を完全に遮断する）。
  const me = await getUserById(env.DB_MAIN, session.user_id);
  if (!me || me.status === "banned") {
    throw new ApiError(401, "unauthorized", "ログイン状態が無効です。ログインし直してください");
  }
  assertSessionNotRevoked(session, me);
  if (request.method !== "GET") {
    await requireCsrf(env, request, session);
  }
  return session;
}

async function audit(env: Env, session: SessionRecord, action: string, target: string | null, detail: unknown): Promise<void> {
  await insertAuditLog(env.DB_MAIN, session.user_id, action, target, detail ? JSON.stringify(detail) : null, Date.now());
}

// ---------------------------------------------------------------------------
// 概要（管理画面トップに表示するダッシュボード）
// ---------------------------------------------------------------------------

export async function handleAdminOverview(env: Env, request: Request): Promise<Response> {
  await requireAdminSession(env, request);
  const now = Date.now();
  const [users, threads, auditToday, knownServers, settings] = await Promise.all([
    countUsers(env.DB_MAIN),
    countVisibleThreads(env.DB_MAIN),
    countAuditLogSince(env.DB_MAIN, now - 24 * 3600 * 1000),
    countKnownServers(env.DB_MAIN),
    getAdminSettings(env),
  ]);

  return jsonResponse({
    users,
    threads,
    auditActionsLast24h: auditToday,
    knownServers,
    turnstileOnAuth: settings.require_turnstile_on_auth,
    turnstileOnPost: settings.require_turnstile_on_post,
    dataRetentionDays: settings.data_retention_days,
  });
}

// ---------------------------------------------------------------------------
// ユーザー管理
// ---------------------------------------------------------------------------

export async function handleSearchUsers(env: Env, request: Request): Promise<Response> {
  await requireAdminSession(env, request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const [users, settings] = await Promise.all([searchUsers(env.DB_MAIN, q, 50), getAdminSettings(env)]);
  return jsonResponse({
    users: users.map((u) => ({
      user_id: u.user_id,
      email: u.email,
      username: u.username,
      role: u.role,
      tier: u.tier,
      status: u.status,
      ban_reason: u.ban_reason,
      created_at: u.created_at,
      // 登録IPは設定がONのときのみ返す（OFF時は常にnull。過去に保存された分も
      // 設定OFF中は表示しないことで、トグルで確実に非表示へできる）
      registration_ip: settings.record_registration_ip ? u.registration_ip ?? null : null,
    })),
  });
}

export async function handleBanUser(env: Env, request: Request, userId: string): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<{ reason?: string }>(request);
  const target = await getUserById(env.DB_MAIN, userId);
  if (!target) throw new ApiError(404, "not_found", "ユーザーが見つかりません");
  if (target.role === "admin") throw new ApiError(400, "cannot_ban_admin", "管理者アカウントはBANできません");

  await setUserBanStatus(env.DB_MAIN, userId, true, (body.reason ?? "").slice(0, 500) || "規約違反", Date.now());
  // HMACセッションモードでは即時失効のためセッション行も削除する
  // （JWTモードでは次回の投稿時のD1 status確認・次回ログインで反映）。
  await deleteD1SessionsForUser(env.DB_MAIN, userId);
  await audit(env, session, "ban_user", userId, { reason: body.reason });
  return jsonResponse({ ok: true });
}

// POST /api/admin/users/:id/reset-password — 管理者によるパスワード再設定。
// bodyのpasswordが空なら仮パスワードを自動生成して返す（平文はレスポンス1回のみ・
// 監査ログには記録しない）。updateUserPassword が users.sessions_invalidated_at へ
// 変更時刻を記録するため、JWT/HMACどちらのモードでも対象ユーザーの既存セッションは
// 即時失効する（対象は全端末で再ログインが必要。0007マイグレーション参照）。
export async function handleAdminResetPassword(env: Env, request: Request, userId: string): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<{ password?: string }>(request);
  const settings = await getAdminSettings(env);
  const target = await getUserById(env.DB_MAIN, userId);
  if (!target) throw new ApiError(404, "not_found", "ユーザーが見つかりません");

  let newPassword = typeof body.password === "string" ? body.password.trim() : "";
  let generated = false;
  if (newPassword.length === 0) {
    // base64url12文字（半角印字可能・8文字以上を満たす仮パスワード）
    newPassword = randomToken(9);
    generated = true;
  }
  if (newPassword.length < 8 || newPassword.length > settings.password_max_len) {
    throw new ApiError(400, "weak_password", `パスワードは8文字以上${settings.password_max_len}文字以下にしてください`);
  }
  // auth.tsの登録/変更と同じ半角印字可能文字制限（全角不可）
  if (!ASCII_PRINTABLE_REGEX.test(newPassword)) {
    throw new ApiError(400, "weak_password", "パスワードは半角文字のみ使用できます（全角・日本語は入力できません）");
  }

  const { hash, salt, iterations } = await hashPassword(newPassword, env.PASSWORD_PEPPER);
  await updateUserPassword(env.DB_MAIN, userId, hash, salt, iterations, Date.now());
  await deleteD1SessionsForUser(env.DB_MAIN, userId);
  await audit(env, session, "reset_password", userId, { generated });
  return jsonResponse({
    ok: true,
    generated,
    // 自動生成時のみ平文を返す（管理者がユーザーへ安全に伝達する。保存はされない）
    generatedPassword: generated ? newPassword : undefined,
  });
}

// POST /api/admin/privacy/purge-registration-ips — 保存済み登録IPの一括消去。
// 登録IPトグルをOFFにする際の即時消去用（OFF後もDBに残らないようにする）。
export async function handlePurgeRegistrationIps(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const cleared = await clearRegistrationIps(env.DB_MAIN);
  await audit(env, session, "purge_registration_ips", null, { cleared });
  return jsonResponse({ ok: true, cleared });
}

export async function handleUnbanUser(env: Env, request: Request, userId: string): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const target = await getUserById(env.DB_MAIN, userId);
  if (!target) throw new ApiError(404, "not_found", "ユーザーが見つかりません");

  await setUserBanStatus(env.DB_MAIN, userId, false, null, Date.now());
  await audit(env, session, "unban_user", userId, null);
  return jsonResponse({ ok: true });
}

export async function handleSetUserRole(env: Env, request: Request, userId: string): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<{ role?: string }>(request);
  if (body.role !== "user" && body.role !== "admin") {
    throw new ApiError(400, "invalid_role", "roleは'user'または'admin'を指定してください");
  }
  const target = await getUserById(env.DB_MAIN, userId);
  if (!target) throw new ApiError(404, "not_found", "ユーザーが見つかりません");

  await setUserRole(env.DB_MAIN, userId, body.role, Date.now());
  // role変更はJWT/HMACどちらのモードでも「ログイン時点のrole」を持つため、
  // セッションを失効させて再ログインを促す（HMACモードは即時失効・JWTモードは
  // 次回ログイン時に新しいroleが反映される）。
  await deleteD1SessionsForUser(env.DB_MAIN, userId);
  await audit(env, session, "set_role", userId, { role: body.role });
  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// 投稿・スレッド管理（シャード解決したうえで対象DBへ操作する）
// ---------------------------------------------------------------------------

export async function handleModeratePost(
  env: Env,
  request: Request,
  threadId: number,
  postId: number,
  action: "hide" | "delete" | "unhide"
): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const shard = await getThreadShard(env, threadId);
  const db = getShardDb(env, shard);
  const status = action === "delete" ? "deleted" : action === "hide" ? "hidden" : "visible";
  await setPostStatus(db, postId, status);
  await audit(env, session, `post_${action}`, `${threadId}:${postId}`, null);
  return jsonResponse({ ok: true });
}

export async function handleModerateThread(
  env: Env,
  request: Request,
  threadId: number,
  action: "hide" | "delete" | "unhide"
): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const shard = await getThreadShard(env, threadId);
  const db = getShardDb(env, shard);
  const status = action === "delete" ? "deleted" : action === "hide" ? "hidden" : "visible";
  await setThreadStatus(db, threadId, status);
  await audit(env, session, `thread_${action}`, String(threadId), null);
  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// スレッド一覧・完全削除（管理画面「スレッド」タブ用）
// ---------------------------------------------------------------------------

// GET /api/admin/threads?limit=&offset=        … DB_MAINのスレッドを新しい順で一覧
// GET /api/admin/threads?threadId=123          … 移行済みシャード含めmanifest経由で解決
export async function handleAdminListThreads(env: Env, request: Request): Promise<Response> {
  await requireAdminSession(env, request);
  const url = new URL(request.url);

  const idParam = url.searchParams.get("threadId");
  if (idParam) {
    const threadId = Number(idParam);
    if (!Number.isInteger(threadId) || threadId <= 0) {
      throw new ApiError(400, "invalid_thread_id", "スレッドIDは正の整数で指定してください");
    }
    // manifestを見て移行済みスレッドの保存先シャードを解決してから取得する
    const shard = await getThreadShard(env, threadId);
    const db = getShardDb(env, shard);
    const thread = await getThread(db, threadId);
    if (!thread) return jsonResponse({ threads: [] });
    const postCount = await countPostsInThread(db, threadId);
    return jsonResponse({ threads: [{ ...thread, post_count: postCount, shard }] });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const threads = await adminListThreads(env.DB_MAIN, limit, offset);
  return jsonResponse({ threads });
}

// スレッドを「レス全件ごと」完全削除する（ソフトデリートではなく実DELETE）。
// スレッド移行は必ず「スレッド＋そのレス全件」を単位として行われる設計のため、
// manifestのshard値を見れば全レスの保存先が分かる（投稿時刻ごとの個別判定は不要）。
// 移行途中で失敗した残骸（manifest更新済みでmainにコピーが残るケース）も
// 念のためmain側からも削除しておく。
export async function handlePurgeThread(env: Env, request: Request, threadId: number): Promise<Response> {
  const session = await requireAdminSession(env, request);

  const shard = await getThreadShard(env, threadId);
  const db = getShardDb(env, shard);
  const thread = await getThread(db, threadId);
  if (!thread) {
    throw new ApiError(404, "not_found", "スレッドが見つかりません（既に削除済みの可能性があります）");
  }
  const postCount = await countPostsInThread(db, threadId);

  await db.batch([
    db.prepare("DELETE FROM posts WHERE thread_id = ?").bind(threadId),
    db.prepare("DELETE FROM threads WHERE thread_id = ?").bind(threadId),
  ]);
  if (shard !== "main") {
    await env.DB_MAIN.batch([
      env.DB_MAIN.prepare("DELETE FROM posts WHERE thread_id = ?").bind(threadId),
      env.DB_MAIN.prepare("DELETE FROM threads WHERE thread_id = ?").bind(threadId),
    ]);
  }
  await deleteManifestEntry(env, threadId);

  await audit(env, session, "purge_thread", String(threadId), { shard, deletedPosts: postCount });
  return jsonResponse({ ok: true, thread_id: threadId, shard, deletedPosts: postCount });
}

// ---------------------------------------------------------------------------
// 設定管理（ハードコード禁止項目をD1 admin_settingsで変更可能にする）
// ---------------------------------------------------------------------------

export async function handleGetSettings(env: Env, request: Request): Promise<Response> {
  await requireAdminSession(env, request);
  const settings = await getAdminSettings(env, true);
  return jsonResponse({ settings });
}

const ALLOWED_SETTING_KEYS = new Set([
  "daily_limit_new",
  "daily_limit_regular",
  "min_interval_new_sec",
  "min_interval_regular_sec",
  "max_body_len",
  "max_urls",
  "promotion_distinct_days",
  "require_turnstile_on_post",
  "require_turnstile_on_auth",
  "data_retention_days",
  // ユーザー名設定（管理画面「設定」タブの「ユーザー名」セクションから変更可能）
  "username_min_len",
  "username_max_len",
  "username_daily_change_limit",
  // パスワードの最大文字数（新規登録時に適用）
  "password_max_len",
  // プライバシー・サーバー監視（登録IP記録のON/OFF・サーバー自動削除日数）
  "record_registration_ip",
  "server_auto_removal_days",
  // 認証方式（"jwt" | "hmac"）と使用するD1の数（1〜3）
  "auth_mode",
  "db_shard_count",
]);

// 半角印字可能文字のみか（auth.tsの登録/変更と同じ制約）
const ASCII_PRINTABLE_REGEX = /^[\x20-\x7E]+$/;

// 値の形式が限定される設定キーのバリデーション（自由テキストを防ぐ）
function validateSettingValue(key: string, value: string | number | boolean): void {
  if (key === "auth_mode" && value !== "jwt" && value !== "hmac") {
    throw new ApiError(400, "invalid_setting_value", "auth_modeは'jwt'または'hmac'を指定してください");
  }
  if (key === "db_shard_count") {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 3) {
      throw new ApiError(400, "invalid_setting_value", "db_shard_countは1〜3の整数で指定してください");
    }
  }
  if (key === "record_registration_ip") {
    const s = String(value);
    if (s !== "0" && s !== "1" && s !== "true" && s !== "false") {
      throw new ApiError(400, "invalid_setting_value", "record_registration_ipは0（OFF）または1（ON）で指定してください");
    }
  }
  if (key === "server_auto_removal_days") {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 7) {
      throw new ApiError(400, "invalid_setting_value", "server_auto_removal_daysは1〜7の整数で指定してください");
    }
  }
}

export async function handleUpdateSettings(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<Record<string, string | number | boolean>>(request);

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new ApiError(400, "invalid_setting_key", `未知の設定キーです: ${key}`);
    }
    validateSettingValue(key, value);
    await setAdminSetting(env, key, String(value));
  }
  await audit(env, session, "update_settings", null, body);
  const settings = await getAdminSettings(env, true);
  return jsonResponse({ settings });
}

// ---------------------------------------------------------------------------
// 監査ログ
// ---------------------------------------------------------------------------

export async function handleAuditLog(env: Env, request: Request): Promise<Response> {
  await requireAdminSession(env, request);
  const logs = await listAuditLog(env.DB_MAIN, 200);
  return jsonResponse({ logs });
}

// ---------------------------------------------------------------------------
// D1シャード移行（容量分散: Main→Shard1 または Shard1→Shard2）。
// 1回の呼び出しで少数スレッドのみ処理する。
// Cron Triggerからも同じロジックを呼び出す（src/index.ts scheduled()参照）。
// ---------------------------------------------------------------------------

export async function handleMigrateShard(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<{
    sourceShard?: "main" | "shard1";
    targetShard?: "shard1" | "shard2";
    cutoffDays?: number;
    batchLimit?: number;
  }>(request);

  const sourceShard = body.sourceShard === "shard1" ? "shard1" : "main";
  const targetShard = body.targetShard === "shard2" ? "shard2" : "shard1";
  if (sourceShard === targetShard) {
    throw new ApiError(400, "invalid_shard_pair", "移行元と移行先が同じシャードです");
  }
  const cutoffDays = body.cutoffDays ?? 180;
  const batchLimit = Math.min(body.batchLimit ?? 20, 50);
  const cutoffTs = Date.now() - cutoffDays * 86400 * 1000;

  const result = await migrateOldThreads(env, sourceShard, targetShard, cutoffTs, batchLimit);
  await audit(env, session, "migrate_shard", `${sourceShard}->${targetShard}`, result);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------------
// 保持期間を超えた投稿の自動削除（R2の代わりにShard1/Shard2から完全削除する）。
// ---------------------------------------------------------------------------

export async function handlePurgeExpired(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  const body = await readJson<{ shard?: string; retentionDays?: number; batchLimit?: number }>(request);

  const shard: "main" | "shard1" | "shard2" = body.shard === "shard1" ? "shard1" : body.shard === "main" ? "main" : "shard2";
  const settings = await getAdminSettings(env);
  const retentionDays = body.retentionDays ?? settings.data_retention_days;
  const batchLimit = Math.min(body.batchLimit ?? 20, 50);
  const cutoffTs = Date.now() - retentionDays * 86400 * 1000;

  const result = shard === "main" ? await deleteExpiredThreadsInMain(env, cutoffTs, batchLimit) : await deleteExpiredThreads(env, shard, cutoffTs, batchLimit);
  await audit(env, session, "purge_expired", shard, result);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------------
// Primary/Backup 同期（reconciliation）。
// Backup Domain経由で受け付けられた投稿（origin='backup'）をPrimaryが
// 後から取り込むための手動/定期リコンサイル用エンドポイント。
// セッションではなく共有シークレット(SYNC_SECRET)で認証する
// サーバー間APIである点に注意。README「Primary/Backup構成」を参照。
// ---------------------------------------------------------------------------

export async function handlePullFromBackup(env: Env, request: Request): Promise<Response> {
  const providedSecret = request.headers.get("X-Sync-Secret") ?? "";
  if (!timingSafeEqualStr(providedSecret, env.SYNC_SECRET)) {
    throw new ApiError(403, "invalid_sync_secret", "同期シークレットが不正です");
  }
  const body = await readJson<{ threads: Array<{ title: string; created_by: string; created_at: number; posts: Array<{ user_id: string; body: string; created_at: number }> }> }>(request);

  const importedThreadIds: number[] = [];
  for (const t of body.threads ?? []) {
    const res = await env.DB_MAIN.prepare(
      `INSERT INTO threads (title, created_by, created_at, last_activity_at, status, origin) VALUES (?, ?, ?, ?, 'visible', 'backup')`
    )
      .bind(t.title, t.created_by, t.created_at, t.created_at)
      .run();
    const threadId = Number(res.meta.last_row_id);
    const stmts = t.posts.map((p) =>
      env.DB_MAIN.prepare(
        `INSERT INTO posts (thread_id, user_id, body, created_at, edited_at, status, origin) VALUES (?, ?, ?, ?, NULL, 'visible', 'backup')`
      ).bind(threadId, p.user_id, p.body, p.created_at)
    );
    if (stmts.length > 0) await env.DB_MAIN.batch(stmts);
    importedThreadIds.push(threadId);
  }

  return jsonResponse({ importedThreadIds });
}
