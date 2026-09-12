// D1クエリヘルパー群。全クエリはプレースホルダ(`?`)を使用し、
// ユーザー入力を直接SQL文字列へ連結しない（SQLインジェクション対策）。

import type { ContentStatus, KnownServerRecord, PostRecord, ServerHealth, ServerType, ThreadRecord, UserRecord, UserRole } from "../types";

// ---------------------------------------------------------------------------
// users (DB_MAIN専用)
// ---------------------------------------------------------------------------

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
    .bind(email.toLowerCase())
    .first<UserRecord>();
  return row ?? null;
}

export async function getUserById(db: D1Database, userId: string): Promise<UserRecord | null> {
  const row = await db.prepare("SELECT * FROM users WHERE user_id = ? LIMIT 1").bind(userId).first<UserRecord>();
  return row ?? null;
}

export async function insertUser(db: D1Database, user: UserRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users
        (user_id, email, username, password_hash, password_salt, password_iterations, role, tier, status, ban_reason, created_at, updated_at, registration_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      user.user_id,
      user.email.toLowerCase(),
      user.username,
      user.password_hash,
      user.password_salt,
      user.password_iterations,
      user.role,
      user.tier,
      user.status,
      user.ban_reason,
      user.created_at,
      user.updated_at,
      user.registration_ip ?? null
    )
    .run();
}

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRecord | null> {
  const row = await db.prepare("SELECT * FROM users WHERE username = ? LIMIT 1").bind(username).first<UserRecord>();
  return row ?? null;
}

// 戻り値: 成功した場合true。UNIQUE制約違反（既に使われているユーザー名）の
// 場合はfalseを返す（例外を投げず、呼び出し側でユーザーへ分かりやすいエラーを返せるようにする）。
export async function setUsername(db: D1Database, userId: string, username: string, now: number): Promise<boolean> {
  try {
    await db
      .prepare("UPDATE users SET username = ?, updated_at = ? WHERE user_id = ?")
      .bind(username, now, userId)
      .run();
    return true;
  } catch (err) {
    // D1はUNIQUE制約違反時にエラーをthrowする（SQLITE_CONSTRAINT）。
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
    throw err;
  }
}

export async function recordLoginDay(db: D1Database, userId: string, loginDate: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO user_login_days (user_id, login_date) VALUES (?, ?)")
    .bind(userId, loginDate)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countDistinctLoginDays(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as c FROM user_login_days WHERE user_id = ?")
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// username_change_counts (DB_MAIN専用) — ユーザー名変更の1日あたり回数制限用。
// 成功した変更のみをUTC日付ごとにカウントする（マイグレーション0003で追加）。
// ---------------------------------------------------------------------------

export async function countUsernameChangesOnDay(db: D1Database, userId: string, dayKey: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM username_change_counts WHERE user_id = ? AND change_date = ?")
    .bind(userId, dayKey)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function recordUsernameChange(db: D1Database, userId: string, dayKey: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO username_change_counts (user_id, change_date, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, change_date) DO UPDATE SET count = count + 1`
    )
    .bind(userId, dayKey)
    .run();
}

export async function promoteUserToRegular(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE users SET tier = 'regular', updated_at = ? WHERE user_id = ? AND tier = 'new'")
    .bind(now, userId)
    .run();
}

export async function setUserBanStatus(
  db: D1Database,
  userId: string,
  banned: boolean,
  reason: string | null,
  now: number
): Promise<void> {
  await db
    .prepare("UPDATE users SET status = ?, ban_reason = ?, updated_at = ? WHERE user_id = ?")
    .bind(banned ? "banned" : "active", banned ? reason : null, now, userId)
    .run();
}

export async function setUserRole(db: D1Database, userId: string, role: UserRole, now: number): Promise<void> {
  await db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE user_id = ?").bind(role, now, userId).run();
}

// ---------------------------------------------------------------------------
// アカウントセルフサービス（設定画面）— メール変更・パスワード変更・退会
// ---------------------------------------------------------------------------

// メールアドレス変更。UNIQUE制約違反（既に誰かが使用中のメール）の場合は
// falseを返す（ setUsername と同じ方針。事前の存在チェックと二重防御）。
export async function updateUserEmail(db: D1Database, userId: string, email: string, now: number): Promise<boolean> {
  try {
    await db
      .prepare("UPDATE users SET email = ?, updated_at = ? WHERE user_id = ?")
      .bind(email.toLowerCase(), now, userId)
      .run();
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
    throw err;
  }
}

// パスワード変更。ソルトは新規に生成したものを呼び出し側から渡す
// （ハッシュ生成はhashPassword()が担うため、ここではDB更新のみ行う）。
// 同時に sessions_invalidated_at（UNIX秒）も記録する
// （マイグレーション0007。管理者による再設定・設定画面での自己変更の両方の
// 呼び出し元がここを通るため、1クエリで「それ以前に発行された全セッションの
// 失効記録」が済む。追加のD1書き込みは発生しない）。
export async function updateUserPassword(
  db: D1Database,
  userId: string,
  hash: string,
  salt: string,
  iterations: number,
  now: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ?, sessions_invalidated_at = ? WHERE user_id = ?"
    )
    .bind(hash, salt, iterations, now, Math.floor(now / 1000), userId)
    .run();
}

// 退会処理: 投稿・スレッドの表示名を空文字へ置き換える（= フロントエンドの
// `username || "名無しさん"` フォールバックで「名無しさん」と表示される）。
// posts/threadsはDB_MAINとシャードに分散しているため、全D1に対して実行する
// （呼び出し側で全DBを渡す）。本文・スレッド自体は残す（他の人の返信を含む
// スレッドを消すと共有コンテンツが失われるため。仕様はREADME参照）。
export async function anonymizeUserPosts(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE posts SET username = '' WHERE user_id = ?").bind(userId).run();
}

export async function anonymizeUserThreads(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE threads SET username = '' WHERE created_by = ?").bind(userId).run();
}

// 退会時にusers行を削除する。UNIQUE制約により、退会後は同じメールアドレス・
// ユーザー名での再登録が可能になる（email/usernameはusers表でのみ一意管理）。
export async function deleteUserById(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
}

export async function deleteLoginDaysForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM user_login_days WHERE user_id = ?").bind(userId).run();
}

export async function deleteUsernameChangeCountsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM username_change_counts WHERE user_id = ?").bind(userId).run();
}

// メール変更時にHMACモードのセッション行へ新しいメールを反映する
// （JWTモードのemailクレームは検証時にDB値で上書き表示されるため影響なし）。
export async function updateD1SessionsEmailForUser(db: D1Database, userId: string, email: string): Promise<void> {
  await db.prepare("UPDATE d1_sessions SET email = ? WHERE user_id = ?").bind(email.toLowerCase(), userId).run();
}

export async function searchUsers(db: D1Database, query: string, limit = 25): Promise<UserRecord[]> {
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const res = await db
    .prepare(
      `SELECT * FROM users WHERE email LIKE ? ESCAPE '\\' OR user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .bind(like, query, limit)
    .all<UserRecord>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// threads / posts (DB_MAIN または各シャードDBに対して共通に使えるヘルパー)
// ---------------------------------------------------------------------------

export async function createThread(
  db: D1Database,
  title: string,
  createdBy: string,
  username: string,
  now: number,
  origin: string
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO threads (title, created_by, username, created_at, last_activity_at, status, origin)
       VALUES (?, ?, ?, ?, ?, 'visible', ?)`
    )
    .bind(title, createdBy, username, now, now, origin)
    .run();
  return Number(res.meta.last_row_id);
}

export async function getThread(db: D1Database, threadId: number): Promise<ThreadRecord | null> {
  const row = await db.prepare("SELECT * FROM threads WHERE thread_id = ? LIMIT 1").bind(threadId).first<ThreadRecord>();
  return row ?? null;
}

export async function listVisibleThreads(db: D1Database, limit: number, offset: number): Promise<ThreadRecord[]> {
  const res = await db
    .prepare(
      `SELECT * FROM threads WHERE status = 'visible' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<ThreadRecord>();
  return res.results ?? [];
}

// スレッド名（title）での部分一致検索。LIKE特殊文字（% _ \\）はエスケープし、
// ESCAPE句で素の文字として扱う（SQLインジェクション・ワイルドカード注入対策）。
// SQLiteのLIKEは半角文字のみ大文字小文字を区別しない（全角は区別する）。
export async function searchVisibleThreads(
  db: D1Database,
  query: string,
  limit: number,
  offset: number
): Promise<ThreadRecord[]> {
  const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const res = await db
    .prepare(
      `SELECT * FROM threads
       WHERE status = 'visible' AND title LIKE ? ESCAPE '\\'
       ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`
    )
    .bind(like, limit, offset)
    .all<ThreadRecord>();
  return res.results ?? [];
}

export async function touchThreadActivity(db: D1Database, threadId: number, now: number): Promise<void> {
  await db.prepare("UPDATE threads SET last_activity_at = ? WHERE thread_id = ?").bind(now, threadId).run();
}

export async function setThreadStatus(db: D1Database, threadId: number, status: ContentStatus): Promise<void> {
  await db.prepare("UPDATE threads SET status = ? WHERE thread_id = ?").bind(status, threadId).run();
}

export async function insertPost(
  db: D1Database,
  threadId: number,
  userId: string,
  username: string,
  body: string,
  now: number,
  origin: string
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO posts (thread_id, user_id, username, body, created_at, edited_at, status, origin)
       VALUES (?, ?, ?, ?, ?, NULL, 'visible', ?)`
    )
    .bind(threadId, userId, username, body, now, origin)
    .run();
  return Number(res.meta.last_row_id);
}

export async function listPostsForThread(
  db: D1Database,
  threadId: number,
  limit: number,
  beforePostId: number | null
): Promise<PostRecord[]> {
  const stmt = beforePostId
    ? db
        .prepare(
          `SELECT * FROM posts WHERE thread_id = ? AND status != 'deleted' AND post_id < ?
           ORDER BY post_id DESC LIMIT ?`
        )
        .bind(threadId, beforePostId, limit)
    : db
        .prepare(
          `SELECT * FROM posts WHERE thread_id = ? AND status != 'deleted'
           ORDER BY post_id DESC LIMIT ?`
        )
        .bind(threadId, limit);
  const res = await stmt.all<PostRecord>();
  return res.results ?? [];
}

export async function setPostStatus(db: D1Database, postId: number, status: ContentStatus): Promise<void> {
  await db.prepare("UPDATE posts SET status = ? WHERE post_id = ?").bind(status, postId).run();
}

export async function insertAuditLog(
  db: D1Database,
  adminUserId: string,
  action: string,
  target: string | null,
  detail: string | null,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (admin_user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(adminUserId, action, target, detail, now)
    .run();
}

export async function listAuditLog(db: D1Database, limit = 100) {
  const res = await db
    .prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all();
  return res.results ?? [];
}

export async function countUsers(db: D1Database): Promise<{ total: number; banned: number; admins: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) as banned,
              SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins
       FROM users`
    )
    .first<{ total: number; banned: number; admins: number }>();
  return { total: row?.total ?? 0, banned: row?.banned ?? 0, admins: row?.admins ?? 0 };
}

export async function countVisibleThreads(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM threads WHERE status = 'visible'").first<{ c: number }>();
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// 管理画面向けスレッド一覧（admin.tsのhandleAdminListThreadsから使う）
// ---------------------------------------------------------------------------

export interface AdminThreadRow {
  thread_id: number;
  title: string;
  username: string | null;
  created_by: string;
  created_at: number;
  last_activity_at: number;
  status: string;
  post_count: number;
  shard: string;
}

// DB_MAIN上のスレッドを新しい順に一覧表示する（隠匿・削除済みも含め全状態を返す）。
// 移行済み（shard1/shard2）のスレッドはDB_MAINからは存在しないため一覧に出ない
// （manifestを介したスレッドID検索で個別に解決する。admin.ts参照）。
export async function adminListThreads(db: D1Database, limit: number, offset: number): Promise<AdminThreadRow[]> {
  const res = await db
    .prepare(
      `SELECT t.thread_id, t.title, t.username, t.created_by, t.created_at, t.last_activity_at, t.status,
              (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.thread_id) AS post_count,
              COALESCE(m.shard, 'main') AS shard
       FROM threads t
       LEFT JOIN archive_manifest m ON m.thread_id = t.thread_id
       ORDER BY t.last_activity_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<AdminThreadRow>();
  return res.results ?? [];
}

export async function countPostsInThread(db: D1Database, threadId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?")
    .bind(threadId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function countAuditLogSince(db: D1Database, sinceTs: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as c FROM admin_audit_log WHERE created_at >= ?")
    .bind(sinceTs)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getLatestPostMarker(db: D1Database, threadId: number): Promise<number> {
  // ETag/キャッシュ鍵に使う「スレッド内最新post_id」。無ければ0。
  const row = await db
    .prepare("SELECT COALESCE(MAX(post_id), 0) as m FROM posts WHERE thread_id = ?")
    .bind(threadId)
    .first<{ m: number }>();
  return row?.m ?? 0;
}

// ---------------------------------------------------------------------------
// known_servers (DB_MAIN専用) — 複数サーバー（Workers）選択機能
// ---------------------------------------------------------------------------

const MAX_KNOWN_SERVERS = 200; // announce経由の悪用によるテーブル肥大化を防ぐ上限

function normalizeHealth(raw: string | undefined | null): ServerHealth {
  return raw === "up" || raw === "down" ? raw : "unknown";
}

export async function listKnownServers(db: D1Database): Promise<KnownServerRecord[]> {
  const res = await db.prepare("SELECT * FROM known_servers ORDER BY added_at ASC").all<
    Omit<KnownServerRecord, "type" | "health"> & { type?: string; health?: string }
  >();
  // DB上のtype/healthは任意の文字列が入り得るため、未知の値は既定値に寄せる
  return (res.results ?? []).map((r) => ({
    ...r,
    type: normalizeServerType(r.type),
    health: normalizeHealth(r.health),
    last_health_at: r.last_health_at ?? null,
    last_up_at: r.last_up_at ?? null,
    dead_days: typeof r.dead_days === "number" && r.dead_days > 0 ? r.dead_days : 0,
  }));
}

// 未知・未指定の種別はすべて通常サーバーとして扱う（将来の拡張に備えたフォールバック）
export function normalizeServerType(raw: string | undefined | null): ServerType {
  return raw === "anonymous" ? "anonymous" : "normal";
}

export async function countKnownServers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM known_servers").first<{ c: number }>();
  return row?.c ?? 0;
}

// 戻り値: 追加/更新できればtrue。上限到達かつ新規URLの場合はfalse。
export async function upsertKnownServer(
  db: D1Database,
  url: string,
  name: string,
  now: number,
  type: ServerType = "normal"
): Promise<boolean> {
  const existing = await db.prepare("SELECT 1 FROM known_servers WHERE url = ?").bind(url).first();
  if (!existing) {
    const count = await countKnownServers(db);
    if (count >= MAX_KNOWN_SERVERS) return false;
  }
  await db
    .prepare(
      `INSERT INTO known_servers (url, name, type, added_at, last_synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET name = excluded.name, type = excluded.type, last_synced_at = excluded.last_synced_at`
    )
    .bind(url, name, type, now, now)
    .run();
  return true;
}

export async function deleteKnownServer(db: D1Database, url: string): Promise<void> {
  await db.prepare("DELETE FROM known_servers WHERE url = ?").bind(url).run();
}

// ヘルスチェック結果（自分で直接確認した場合も、他サーバーからの共有も
// 同じ関数で反映する）。存在しないURLに対しては何もしない（リストの成長は
// upsertKnownServer経由でのみ行う。呼び出し側で新規サーバーは明示採用する）。
export async function updateServerHealth(
  db: D1Database,
  url: string,
  health: ServerHealth,
  checkedAt: number,
  lastUpAt: number | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE known_servers
       SET health = ?, last_health_at = ?, last_up_at = COALESCE(?, last_up_at)
       WHERE url = ?`
    )
    .bind(health, checkedAt, health === "up" ? checkedAt : lastUpAt, url)
    .run();
}

// 連続到達不能日数の反映（0:01の集約レポート適用用）。
// healthがnullの場合は稼働状態を変更せずdead_daysのみ更新する。
export async function setServerDeadDays(
  db: D1Database,
  url: string,
  deadDays: number,
  health: ServerHealth | null,
  checkedAt: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE known_servers
       SET dead_days = ?, health = COALESCE(?, health), last_health_at = COALESCE(?, last_health_at)
       WHERE url = ?`
    )
    .bind(Math.max(0, Math.floor(deadDays)), health, checkedAt, url)
    .run();
}

// サーバーを「稼働中」へ更新する（管理画面の手動レスポンスチェック成功時・
// サーバー追加時の実在確認通過後に使用・v11.2）。
// last_up_at を現在時刻へ更新し、dead_days（連続到達不能日数の自動削除カウンタ）
// も0へ戻す —— 一時的なエラーで「応答なし」になっていたサーバーを復旧させ、
// 自動削除カウンタもリセットする。
// 戻り値: 対象行があればtrue（無ければfalse = 既知サーバー一覧に存在しないURL）。
export async function markServerUp(db: D1Database, url: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE known_servers
       SET health = 'up', last_health_at = ?, last_up_at = ?, dead_days = 0
       WHERE url = ?`
    )
    .bind(now, now, url)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

// 既知サーバー1行の稼働状態を取得する（手動チェック前の存在確認・前状態の表示用）。
// 存在しないURLの場合はnull。
export async function getKnownServerHealth(
  db: D1Database,
  url: string
): Promise<{ health: ServerHealth } | null> {
  const row = await db
    .prepare("SELECT health FROM known_servers WHERE url = ?")
    .bind(url)
    .first<{ health?: string }>();
  if (!row) return null;
  return { health: normalizeHealth(row.health) };
}

// 管理者向けの1日あたり回数制限を1回消費する（0009 admin_daily_quotas）。
// アトミックに+1してから上限を超えていたら巻き戻す（同時実行でも上限を
// 正確に守るため。巻き戻しは同時実行が衝突したレアケースのみ発生）。
// 戻り値: exceeded=true の場合は上限超過（カウンタは消費後に巻き戻し済み）。
//         exceeded=false の場合は remaining = 残り回数。
export async function consumeAdminDailyQuota(
  db: D1Database,
  userId: string,
  action: string,
  day: string,
  limit: number,
  now: number
): Promise<{ exceeded: boolean; remaining: number }> {
  await db
    .prepare(
      `INSERT INTO admin_daily_quotas (user_id, action, day, used, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, action, day) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`
    )
    .bind(userId, action, day, now)
    .run();
  const row = await db
    .prepare("SELECT used FROM admin_daily_quotas WHERE user_id = ? AND action = ? AND day = ?")
    .bind(userId, action, day)
    .first<{ used: number }>();
  const used = row?.used ?? 1;
  if (used > limit) {
    await db
      .prepare(
        `UPDATE admin_daily_quotas SET used = used - 1, updated_at = ?
         WHERE user_id = ? AND action = ? AND day = ?`
      )
      .bind(now, userId, action, day)
      .run();
    return { exceeded: true, remaining: 0 };
  }
  return { exceeded: false, remaining: Math.max(0, limit - used) };
}

// 保存済みの登録IPをすべて消去する（管理画面の「一括消去」用）。
// 消去した行数を返す。
export async function clearRegistrationIps(db: D1Database): Promise<number> {
  const res = await db
    .prepare("UPDATE users SET registration_ip = NULL WHERE registration_ip IS NOT NULL")
    .run();
  return Number(res.meta?.changes ?? 0);
}

// ---------------------------------------------------------------------------
// server_access_stats (DB_MAIN専用) — 日次ヘルスチェック担当サーバーの選定用。
// 各サーバーが毎日23:59(JST)に自分のアクセス数を共有し合い、翌0:00に
// 「前日のアクセスが少なかった順」で最大3サーバー（総数3以下なら全員）を
// チェック担当として全サーバーが決定できるようにする（決定論的アルゴリズム）。
// ---------------------------------------------------------------------------

export async function recordAccessStat(
  db: D1Database,
  serverUrl: string,
  statDate: string,
  requestCount: number,
  reportedAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO server_access_stats (server_url, stat_date, request_count, reported_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_url, stat_date) DO UPDATE SET
         request_count = excluded.request_count,
         reported_at = excluded.reported_at`
    )
    .bind(serverUrl, statDate, Math.max(0, Math.floor(requestCount)), reportedAt)
    .run();
}

export async function listAccessStatsForDate(
  db: D1Database,
  statDate: string
): Promise<{ server_url: string; request_count: number }[]> {
  const res = await db
    .prepare("SELECT server_url, request_count FROM server_access_stats WHERE stat_date = ? AND reported_at IS NOT NULL")
    .bind(statDate)
    .all<{ server_url: string; request_count: number }>();
  return res.results ?? [];
}

// 古い統計行の掃除（7日より前を削除。1日1回23:59のcronから呼ぶ）
export async function pruneOldAccessStats(db: D1Database, olderThanDate: string): Promise<void> {
  await db.prepare("DELETE FROM server_access_stats WHERE stat_date < ?").bind(olderThanDate).run();
}

// ---------------------------------------------------------------------------
// d1_sessions (DB_MAIN専用) — HMACセッションモード用のサーバー側セッション。
// JWTモードでは一切使われない（モード判定はCookie値の形式で行う: "sid_" 接頭辞）。
// ---------------------------------------------------------------------------

export interface D1SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  role: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export async function insertD1Session(db: D1Database, row: D1SessionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO d1_sessions (session_id, user_id, email, role, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.session_id, row.user_id, row.email, row.role, row.created_at, row.last_seen_at, row.expires_at)
    .run();
}

export async function getD1Session(db: D1Database, sessionId: string): Promise<D1SessionRow | null> {
  const row = await db.prepare("SELECT * FROM d1_sessions WHERE session_id = ? LIMIT 1").bind(sessionId).first<D1SessionRow>();
  return row ?? null;
}

export async function deleteD1Session(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM d1_sessions WHERE session_id = ?").bind(sessionId).run();
}

// BAN・role変更時にそのユーザーの全セッションを失効させる（即時反映）。
export async function deleteD1SessionsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM d1_sessions WHERE user_id = ?").bind(userId).run();
}

// 期限切れセッションの一括掃除（1日1回のcronから呼ぶ。D1 write 1回/日）
export async function purgeExpiredD1Sessions(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM d1_sessions WHERE expires_at < ?").bind(nowMs).run();
}

// ---------------------------------------------------------------------------
// APIキー（v11: 外部ツール用の正規認証経路。詳細はsrc/middleware/auth.ts参照）
// キー本体は平文保存せずSHA-256ハッシュ（key_hash）のみ保存する（0008マイグレーション）
// ---------------------------------------------------------------------------

export interface ApiKeyRow {
  key_id: string;
  user_id: string;
  key_hash: string;
  label: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
}

export async function insertApiKey(db: D1Database, row: ApiKeyRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_keys (key_id, user_id, key_hash, label, key_prefix, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.key_id, row.user_id, row.key_hash, row.label, row.key_prefix, row.created_at, row.last_used_at)
    .run();
}

export async function getApiKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  const row = await db.prepare("SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1").bind(keyHash).first<ApiKeyRow>();
  return row ?? null;
}

export async function listApiKeysForUser(db: D1Database, userId: string): Promise<ApiKeyRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<ApiKeyRow>();
  return results ?? [];
}

export async function countApiKeysForUser(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

// 所有者一致するキーのみ削除する（他人のキーを失効させられない）。対象が無ければfalse。
export async function deleteApiKey(db: D1Database, keyId: string, userId: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM api_keys WHERE key_id = ? AND user_id = ?").bind(keyId, userId).run();
  return (res.meta.changes ?? 0) > 0;
}

// 最終使用時刻の更新。 getSessionFromApiKey から60秒に1回までの間隔で呼ばれる
// （毎リクエスト更新するとD1 write消費が読み取り系ツールで問題になるため）。
export async function touchApiKeyLastUsed(db: D1Database, keyId: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?").bind(now, keyId).run();
}
