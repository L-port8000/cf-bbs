import { ApiError, DEFAULT_USERNAME, type Env } from "../types";
import {
  createThread,
  getThread,
  insertPost,
  listPostsForThread,
  listVisibleThreads,
  searchVisibleThreads,
  touchThreadActivity,
  getLatestPostMarker,
} from "../db/queries";
import { getShardDb, getThreadShard } from "../db/sharding";
import { assertSessionNotRevoked, getSessionFromRequest, requireCsrf, requireSession, requireValidOrigin, requireJsonContentType, requireContentLengthWithin } from "../middleware/auth";
import { checkPostRateLimit } from "../middleware/rateLimit";
import { getAdminSettings } from "../utils/settings";
import { verifyTurnstileDetailed, turnstileUserMessage } from "../utils/turnstile";
import { getClientIp } from "../middleware/rateLimit";
import { graphemeLength, countUrls } from "../utils/segmenter";
import { jsonResponse } from "../utils/response";
import { getFromCache, putInCache, withCacheHeaders } from "../utils/cache";
import { getUserById } from "../db/queries";

const MAX_POST_BODY_BYTES = 8192; // 200書記素+マージンを十分に超える上限（巨大Body拒否）
const MAX_TITLE_LEN = 100;

function sanitizePlainText(input: string): string {
  // 制御文字（改行・タブは許可）を除去し、プレーンテキストとして扱う。
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  requireJsonContentType(request);
  requireContentLengthWithin(request, maxBytes);
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
}

// ---------------------------------------------------------------------------
// GET /api/threads — 新着スレッド一覧（DB_MAINのみを検索。Shard1/Shard2へ
// 移行済みのスレッドは定義上activityが古いため一覧には出さない）。
// v10から ?q= でスレッド名（title）の部分一致検索が可能（v10新設）。
// ---------------------------------------------------------------------------
export async function handleListThreads(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 50);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  // 検索語: 前後空白を除去・最大100文字。空なら通常の一覧と同じ挙動
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);

  const cacheKeyRequest = new Request(url.toString(), { method: "GET" });
  const cached = await getFromCache(cacheKeyRequest);
  if (cached) return cached;

  const threads = q ? await searchVisibleThreads(env.DB_MAIN, q, limit, offset) : await listVisibleThreads(env.DB_MAIN, limit, offset);
  const response = withCacheHeaders({ threads, query: q || undefined }, 15, `"threads-${offset}-${limit}-${q}-${threads[0]?.thread_id ?? 0}"`);
  await putInCache(cacheKeyRequest, response.clone(), ctx);
  return response;
}

// ---------------------------------------------------------------------------
// POST /api/threads — 新規スレッド作成（＝最初の投稿を兼ねる）
// ---------------------------------------------------------------------------
export async function handleCreateThread(env: Env, request: Request): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readJsonBody<{ title?: string; body?: string; turnstileToken?: string }>(request, MAX_POST_BODY_BYTES);
  const title = sanitizePlainText((body.title ?? "").trim());
  const postBody = sanitizePlainText((body.body ?? "").trim());

  if (title.length === 0 || graphemeLength(title) > MAX_TITLE_LEN) {
    throw new ApiError(400, "invalid_title", `タイトルは1〜${MAX_TITLE_LEN}文字で入力してください`);
  }

  const user = await getUserById(env.DB_MAIN, session.user_id);
  if (!user || user.status === "banned") {
    throw new ApiError(403, "forbidden", "投稿権限がありません");
  }
  // パスワード変更で失効した古いトークンによる投稿を防ぐ（0007）。
  // ユーザー行は上で取得済みのため追加のD1読み取りは不要。
  assertSessionNotRevoked(session, user);

  const settings = await getAdminSettings(env);
  validatePostBody(postBody, settings.max_body_len, settings.max_urls);

  // 管理画面の「投稿時にTurnstileを要求する」設定を実際に強制する
  // （従来は設定UIだけ存在しサーバー側で効いていなかった）。既定はオフ。
  // APIキー（外部ツール）はTurnstileを解けないため対象外（キー所持が代替。
  // レート制限は通常投稿と同じく適用される・v11）。
  if (settings.require_turnstile_on_post && session.authVia !== "apikey") {
    const result = await verifyTurnstileDetailed(env, body.turnstileToken, getClientIp(request));
    if (!result.ok) {
      throw new ApiError(400, "turnstile_failed", turnstileUserMessage(result.errors));
    }
  }

  const rate = await checkPostRateLimit(env, user.user_id, user.tier);
  if (!rate.allowed) {
    throw rateLimitError(rate);
  }

  const now = Date.now();
  const displayName = user.username ?? DEFAULT_USERNAME;
  const threadId = await createThread(env.DB_MAIN, title, user.user_id, displayName, now, env.DEPLOYMENT_ROLE);
  await insertPost(env.DB_MAIN, threadId, user.user_id, displayName, postBody, now, env.DEPLOYMENT_ROLE);

  return jsonResponse({ thread_id: threadId }, { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/threads/:id/posts — スレッド内投稿一覧（manifestでシャード解決）
// ---------------------------------------------------------------------------
export async function handleListPosts(env: Env, request: Request, ctx: ExecutionContext, threadId: number): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 100);
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? Number(beforeParam) : null;

  const cacheKeyRequest = new Request(url.toString(), { method: "GET" });
  const cached = await getFromCache(cacheKeyRequest);
  if (cached) return cached;

  const shard = await getThreadShard(env, threadId);

  const db = getShardDb(env, shard);
  const thread = await getThread(db, threadId);
  if (!thread || thread.status === "deleted") {
    throw new ApiError(404, "not_found", "スレッドが見つかりません");
  }

  const posts = await listPostsForThread(db, threadId, limit, before);
  const marker = await getLatestPostMarker(db, threadId);

  // shard1/shard2は移行済み＝更新頻度が低いスレッドなので、mainより長めに
  // キャッシュしてD1 Readをさらに削減する。
  const cacheTtl = shard === "main" ? 10 : 120;
  const response = withCacheHeaders({ thread, posts }, cacheTtl, `"${shard}-${threadId}-${marker}"`);
  await putInCache(cacheKeyRequest, response.clone(), ctx);
  return response;
}

// ---------------------------------------------------------------------------
// POST /api/threads/:id/posts — 返信投稿
// ---------------------------------------------------------------------------
export async function handleCreatePost(env: Env, request: Request, threadId: number): Promise<Response> {
  requireValidOrigin(env, request);
  const session = await requireSession(env, request);
  await requireCsrf(env, request, session);

  const body = await readJsonBody<{ body?: string; turnstileToken?: string }>(request, MAX_POST_BODY_BYTES);
  const postBody = sanitizePlainText((body.body ?? "").trim());

  const user = await getUserById(env.DB_MAIN, session.user_id);
  if (!user || user.status === "banned") {
    throw new ApiError(403, "forbidden", "投稿権限がありません");
  }
  // パスワード変更で失効した古いトークンによる返信を防ぐ（0007）
  assertSessionNotRevoked(session, user);

  const settings = await getAdminSettings(env);
  validatePostBody(postBody, settings.max_body_len, settings.max_urls);

  // 管理画面の「投稿時にTurnstileを要求する」設定を実際に強制する（返信も同様）
  // APIキー（外部ツール）はTurnstile対象外（スレッド作成と同じ扱い・v11）
  if (settings.require_turnstile_on_post && session.authVia !== "apikey") {
    const result = await verifyTurnstileDetailed(env, body.turnstileToken, getClientIp(request));
    if (!result.ok) {
      throw new ApiError(400, "turnstile_failed", turnstileUserMessage(result.errors));
    }
  }

  const shard = await getThreadShard(env, threadId);
  const db = getShardDb(env, shard);
  const thread = await getThread(db, threadId);
  if (!thread || thread.status !== "visible") {
    throw new ApiError(404, "not_found", "スレッドが見つかりません");
  }

  const rate = await checkPostRateLimit(env, user.user_id, user.tier);
  if (!rate.allowed) {
    throw rateLimitError(rate);
  }

  const now = Date.now();
  const displayName = user.username ?? DEFAULT_USERNAME;
  const postId = await insertPost(db, threadId, user.user_id, displayName, postBody, now, env.DEPLOYMENT_ROLE);
  await touchThreadActivity(db, threadId, now);

  return jsonResponse({ post_id: postId }, { status: 201 });
}

function validatePostBody(body: string, maxLen: number, maxUrls: number): void {
  if (body.length === 0) {
    throw new ApiError(400, "empty_body", "本文を入力してください");
  }
  const len = graphemeLength(body);
  if (len > maxLen) {
    throw new ApiError(400, "body_too_long", `本文は${maxLen}文字以内で入力してください（現在${len}文字）`);
  }
  const urls = countUrls(body);
  if (urls > maxUrls) {
    throw new ApiError(400, "too_many_urls", `URLは${maxUrls}個以内にしてください`);
  }
}

function rateLimitError(rate: { reason?: string; retryAfterMs?: number }): ApiError {
  if (rate.reason === "interval") {
    const sec = Math.ceil((rate.retryAfterMs ?? 0) / 1000);
    return new ApiError(429, "post_interval", `投稿間隔が短すぎます。あと${sec}秒お待ちください`);
  }
  return new ApiError(429, "daily_limit", "本日の投稿上限に達しました");
}
