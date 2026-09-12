// 複数サーバー（Workers）選択機能。
//
// 設計方針:
//   - 各サーバー（別Cloudflareアカウント上の独立したcf-bbsデプロイ）は
//     それぞれ独立したD1を持ち、掲示板の内容そのものは共有しない
//     （「同じ内容が表示できなくても良い」という要件に対応）。
//   - 共有するのは「どんなサーバーが存在するか」という一覧(known_servers)
//     のみ。ユーザーは /servers.html の選択画面から好きなサーバーへ移動する。
//   - 一覧の伝搬:
//       1) サーバー登録（管理者/ユーザー）時に、既知の全サーバーへ即時announce。
//          さらに新規サーバーへは「全リスト」をHMAC署名付きでブートストラップ配信。
//       2) 毎日23:59 JSTに各サーバーがアクセス統計を共有し、翌0:00にチェック
//          担当サーバー（最大3台）が全サーバーの生存確認、0:01に結果を公開。
//          詳細は src/routes/cluster.ts を参照。
//       3) 管理者が任意のタイミングで特定サーバーの一覧を手動で取り込む
//          （sync-pull）。
//   - 分散システムとしての厳密な整合性は目指さず、Free Planで現実的に
//     動く範囲にとどめる（詳細はREADME「既知の制約」参照）。

import { ApiError, type Env, type SessionRecord, type ServerType } from "../types";
import {
  consumeAdminDailyQuota,
  countKnownServers,
  deleteKnownServer,
  getKnownServerHealth,
  getUserById,
  listKnownServers,
  markServerUp,
  normalizeServerType,
  updateServerHealth,
  upsertKnownServer,
} from "../db/queries";
import { assertSessionNotRevoked, requireAdmin, requireCsrf, requireSession, requireValidOrigin, requireJsonContentType } from "../middleware/auth";
import { jsonResponse } from "../utils/response";
import { guardAgainstAbuse } from "../utils/dosGuard";
import { insertAuditLog } from "../db/queries";
import { syncSend } from "../utils/clusterSync";
import { DAILY_RESPONSE_CHECK_LIMIT, QUOTA_ACTION_SERVER_CHECK, jstDayKey, pingHealth } from "../utils/serverHealth";

interface ServerDescriptor {
  url: string;
  name: string;
  type: ServerType;
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "invalid_url", "URLの形式が正しくありません");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "invalid_url", "URLはhttps://で始まる必要があります");
  }
  // パス・クエリ・末尾スラッシュを取り除き、オリジンのみに正規化する。
  return `${url.protocol}//${url.host}`;
}

export function selfDescriptor(env: Env): ServerDescriptor {
  return {
    url: `https://${env.PRIMARY_API_DOMAIN}`,
    name: env.SERVER_DISPLAY_NAME || env.PRIMARY_API_DOMAIN,
    type: "normal",
  };
}

// 相手が本当にcf-bbsサーバーとして動作しているかを緩く検証する
// （出鱈目なURLや無関係なサイトが登録されるのを防ぐベストエフォートの確認）。
async function looksLikeCfBbs(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${url}/api/public-config`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = (await res.json()) as { turnstileSiteKey?: unknown };
    return typeof data.turnstileSiteKey === "string";
  } catch {
    return false;
  }
}

async function announceTo(peerUrl: string, entry: ServerDescriptor): Promise<void> {
  try {
    await fetch(`${peerUrl}/api/servers/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // ベストエフォート。相手が落ちていても管理者操作自体は失敗させない。
  }
}

// ---------------------------------------------------------------------------
// GET /api/servers — 公開。選択画面と、他サーバーからのsync-pull元として使う。
// 日次ヘルスチェック（cron・src/routes/cluster.ts参照）の結果
// （health / lastHealthAt / lastUpAt）もあわせて返す。
// ---------------------------------------------------------------------------
export async function handleListServers(env: Env, request: Request): Promise<Response> {
  await guardAgainstAbuse(request, "servers-list", 2);
  const self = selfDescriptor(env);
  const rows = await listKnownServers(env.DB_MAIN);
  const servers = rows
    .filter((r) => r.url !== self.url)
    .map((r) => ({
      url: r.url,
      name: r.name,
      type: r.type,
      health: r.health,
      lastHealthAt: r.last_health_at,
      lastUpAt: r.last_up_at,
      // 連続到達不能日数（自動削除カウンタ。settings.jsのバッジに表示）
      deadDays: r.dead_days ?? 0,
    }));
  // 自分は常に稼働中として返す（自分自身へのチェックは省略する設計のため）
  const selfEntry = { ...self, health: "up" as const, lastHealthAt: Date.now(), lastUpAt: Date.now() };
  return jsonResponse({ self: selfEntry, servers });
}

// ---------------------------------------------------------------------------
// POST /api/servers/announce — 他サーバーからの「こんなサーバーもあるよ」通知。
// 1ホップのみ（受信してもさらに転送しない）。DoS対策とゆるい実在確認つき。
// ---------------------------------------------------------------------------
export async function handleAnnounceServer(env: Env, request: Request): Promise<Response> {
  await guardAgainstAbuse(request, "servers-announce", 5);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { url?: string; name?: string; type?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }

  const url = normalizeUrl(body.url ?? "");
  const name = (body.name ?? url).slice(0, 60);
  const type = normalizeServerType(body.type);
  const self = selfDescriptor(env);
  if (url === self.url) {
    return jsonResponse({ ok: true }); // 自分自身の通知は無視
  }

  const alive = await looksLikeCfBbs(url);
  if (!alive) {
    throw new ApiError(400, "unreachable_server", "指定されたURLはcf-bbsサーバーとして応答しませんでした");
  }

  const count = await countKnownServers(env.DB_MAIN);
  const accepted = await upsertKnownServer(env.DB_MAIN, url, name, Date.now(), type);
  if (!accepted) {
    throw new ApiError(400, "server_list_full", "既知サーバーの登録上限に達しています");
  }
  void count;
  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// 管理者操作: 追加 / 削除 / 他サーバーからの一覧取り込み
// ---------------------------------------------------------------------------

async function requireAdminSession(env: Env, request: Request): Promise<SessionRecord> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  requireAdmin(session);
  // 管理者自身のユーザー行も確認（BAN・パスワード変更による失効を反映・0007）
  const me = await getUserById(env.DB_MAIN, session.user_id);
  if (!me || me.status === "banned") {
    throw new ApiError(401, "unauthorized", "ログイン状態が無効です。ログインし直してください");
  }
  assertSessionNotRevoked(session, me);
  if (request.method !== "GET") await requireCsrf(env, request, session);
  return session;
}

export async function handleAdminAddServer(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { url?: string; name?: string; type?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }

  const url = normalizeUrl(body.url ?? "");
  const name = (body.name ?? url).slice(0, 60) || url;
  const type = normalizeServerType(body.type);
  return addServerCore(env, session.user_id, "add_server", { url, name, type });
}

// サーバー追加の共通コア（管理者追加・一般ユーザーによる登録の両方から使う）。
// 実在確認（looksLikeCfBbs）→ 登録 → 監査ログ → 既知の全サーバーへannounce。
async function addServerCore(
  env: Env,
  actorUserId: string,
  auditAction: string,
  descriptor: ServerDescriptor
): Promise<Response> {
  const { url, name, type } = descriptor;
  const self = selfDescriptor(env);
  if (url === self.url) {
    throw new ApiError(400, "cannot_add_self", "自分自身は追加できません");
  }

  const alive = await looksLikeCfBbs(url);
  if (!alive) {
    throw new ApiError(400, "unreachable_server", "指定されたURLはcf-bbsサーバーとして応答しませんでした");
  }

  const accepted = await upsertKnownServer(env.DB_MAIN, url, name, Date.now(), type);
  if (!accepted) {
    throw new ApiError(400, "server_list_full", "既知サーバーの登録上限に達しています");
  }

  // 実在確認（looksLikeCfBbs）を通った直後 = たった今応答した → 「稼働中」として
  // 登録する（v11.2・ユーザー要望「追加のときにもレスポンス確認してから追加して、
  // 稼働済にしてほしい」）。従来は健康状態unknownのまま翌0:00の自動チェック待ち
  // だったが、これで追加した瞬間から稼働中バッジが付く。dead_days も0に戻るため、
  // 一時的に落ちていた既存サーバーを再追加した場合も自動削除カウンタがリセットされる。
  await markServerUp(env.DB_MAIN, url, Date.now());

  await insertAuditLog(env.DB_MAIN, actorUserId, auditAction, url, JSON.stringify({ name, type }), Date.now());

  // 既存の既知サーバー全部へ、新しいサーバーを知らせる（1ホップのみ）。
  // 同時に、新しいサーバーへ「自分」も知らせておく（相互登録）。
  const peers = await listKnownServers(env.DB_MAIN);
  const announcements: Promise<void>[] = [];
  for (const peer of peers) {
    if (peer.url === url) continue;
    announcements.push(announceTo(peer.url, { url, name, type }));
  }
  announcements.push(announceTo(url, self));
  await Promise.allSettled(announcements);

  // 新規サーバーへは「現在判明している全リスト」も即時配信する（ブートストラップ。
  // これにより新規サーバーは他サーバーの一覧を手動取り込みしなくても即座に把握できる）。
  // HMAC署名付きのサーバー間API（/api/sync/server-list）を使用する。
  await syncSend(env.SYNC_SECRET, url, "POST", "/api/sync/server-list", {
    senderUrl: self.url,
    servers: [
      { url: self.url, name: self.name, type: self.type },
      ...peers.filter((p) => p.url !== url).map((p) => ({ url: p.url, name: p.name, type: p.type })),
    ],
  });

  return jsonResponse({ ok: true, url, name, type, message: "レスポンスを確認し、「稼働中」として登録しました" });
}

// POST /api/servers/register — ログイン済みユーザーによるサーバー登録。
// 「どこかの既存サーバーでアカウントを作り、そのアカウント経由で自分のサーバーを
// 各所に登録してもらう」フローの受け口。悪用対策として:
//   - ログイン+CSRF必須、同一IPの連続試行を間引く（guardAgainstAbuse）
//   - 登録先が本当にcf-bbsとして応答するか実在確認（looksLikeCfBbs）
//   - known_serversの登録上限（MAX_KNOWN_SERVERS）
//   - 監査ログに記録
export async function handleUserRegisterServer(env: Env, request: Request): Promise<Response> {
  await guardAgainstAbuse(request, "servers-register", 20);
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);
  // 失効セッション（パスワード変更済みの古いトークン）・BAN済みユーザーによる
  // 登録を防ぐ（0007。登録は低頻度操作のため+1 readは許容）
  const me = await getUserById(env.DB_MAIN, session.user_id);
  if (!me || me.status === "banned") {
    throw new ApiError(403, "forbidden", "サーバー登録の権限がありません");
  }
  assertSessionNotRevoked(session, me);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { url?: string; name?: string; type?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }

  const url = normalizeUrl(body.url ?? "");
  const name = (body.name ?? url).slice(0, 60) || url;
  const type = normalizeServerType(body.type);
  return addServerCore(env, session.user_id, "register_server", { url, name, type });
}

// ---------------------------------------------------------------------------
// POST /api/admin/servers/check — 管理画面の手動レスポンスチェック（v11.2）。
// 指定した既知サーバーの生存確認（GET /api/health）をその場で実施し、結果を
// known_servers.health へ反映する。日次cronと完全に同じ判定基準（pingHealth）。
//   - 応答あり（up） = health を「稼働中」へ更新。一時的なエラーで「応答なし」に
//     なっていたサーバーをここで復旧させる（dead_days も0にリセット）。
//   - 応答なし（down）= health を「応答なし」へ更新（dead_days は触らない。
//     自動削除カウンタは0:01の複数担当チェックの多数決のみが進める）。
// 1管理者あたり1日10回まで（JST日替わり・0009 admin_daily_quotas）。
// ---------------------------------------------------------------------------
export async function handleAdminCheckServer(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { url?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
  const url = normalizeUrl(body.url ?? "");
  const self = selfDescriptor(env);
  if (url === self.url) {
    throw new ApiError(400, "cannot_check_self", "自分自身は常に稼働中として表示されるためチェック不要です");
  }
  const prev = await getKnownServerHealth(env.DB_MAIN, url);
  if (!prev) {
    throw new ApiError(404, "not_found", "そのURLは既知サーバー一覧に存在しません");
  }

  // 1日10回制限（管理者ごと・JST日替わり）。上限超過時は429（カウンタは巻き戻し済み）。
  const now = Date.now();
  const quota = await consumeAdminDailyQuota(
    env.DB_MAIN,
    session.user_id,
    QUOTA_ACTION_SERVER_CHECK,
    jstDayKey(now),
    DAILY_RESPONSE_CHECK_LIMIT,
    now
  );
  if (quota.exceeded) {
    throw new ApiError(
      429,
      "quota_exceeded",
      `本日のレスポンスチェック回数（1日${DAILY_RESPONSE_CHECK_LIMIT}回）を使い切りました。日本時間の0時にリセットされます`
    );
  }

  const up = await pingHealth(url);
  if (up) {
    await markServerUp(env.DB_MAIN, url, now);
  } else {
    await updateServerHealth(env.DB_MAIN, url, "down", now, null);
  }
  await insertAuditLog(env.DB_MAIN, session.user_id, "server_response_check", url, JSON.stringify({ result: up ? "up" : "down" }), now);

  const remainingText = `本日の残り: ${quota.remaining}/${DAILY_RESPONSE_CHECK_LIMIT}`;
  const message = up
    ? prev.health === "down"
      ? `応答を確認しました。一時的なエラーから復旧し「稼働中」へ更新しました（${remainingText}）`
      : `応答を確認しました。「稼働中」へ更新しました（${remainingText}）`
    : `応答がありませんでした。「応答なし」へ更新しました（${remainingText}）`;
  return jsonResponse({
    ok: true,
    up,
    health: up ? "up" : "down",
    previousHealth: prev.health,
    remainingChecks: quota.remaining,
    level: up ? "success" : "info",
    message,
  });
}

export async function handleAdminRemoveServer(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { url?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
  const url = normalizeUrl(body.url ?? "");
  await deleteKnownServer(env.DB_MAIN, url);
  await insertAuditLog(env.DB_MAIN, session.user_id, "remove_server", url, null, Date.now());
  return jsonResponse({ ok: true });
}

export async function handleAdminSyncPull(env: Env, request: Request): Promise<Response> {
  const session = await requireAdminSession(env, request);
  requireJsonContentType(request);
  const text = await request.text();
  if (text.length > 2048) throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  let body: { peerUrl?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }

  const peerUrl = normalizeUrl(body.peerUrl ?? "");
  let data: { self?: Partial<ServerDescriptor>; servers?: Partial<ServerDescriptor>[] };
  try {
    const res = await fetch(`${peerUrl}/api/servers`);
    if (!res.ok) throw new Error(`peer responded ${res.status}`);
    data = await res.json();
  } catch {
    throw new ApiError(400, "unreachable_server", "指定されたサーバーの一覧取得に失敗しました");
  }

  const self = selfDescriptor(env);
  const candidates: Partial<ServerDescriptor>[] = [...(data.self ? [data.self] : []), ...(data.servers ?? [])];
  let imported = 0;
  const now = Date.now();
  for (const c of candidates) {
    if (!c.url || c.url === self.url) continue;
    const ok = await upsertKnownServer(
      env.DB_MAIN,
      c.url,
      (c.name || c.url).slice(0, 60),
      now,
      normalizeServerType(c.type)
    );
    if (ok) imported++;
  }

  await insertAuditLog(env.DB_MAIN, session.user_id, "sync_pull_servers", peerUrl, JSON.stringify({ imported }), now);
  return jsonResponse({ ok: true, imported });
}
