import { ApiError, type Env, type SessionRecord, type UserRecord } from "../types";
import { getSession, SESSION_COOKIE_NAME } from "./session";
import { CSRF_HEADER_NAME, verifyCsrfToken } from "./csrf";
import { parseCookies } from "../utils/response";
import { sha256Hex } from "../utils/crypto";
import { getApiKeyByHash, getUserById, touchApiKeyLastUsed } from "../db/queries";

export async function getSessionFromRequest(env: Env, request: Request): Promise<SessionRecord | null> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  return getSession(env, cookies[SESSION_COOKIE_NAME]);
}

// ---------------------------------------------------------------------------
// APIキー認証（v11新設・外部ツール用の正規経路）
//
// v11から書き込み系APIは requireValidOrigin の厳格化により「ブラウザ発リクエスト」
// のみ受け付ける（Origin/Referer必須 → curl等の外部ツールは既定で403）。
// 外部ツールからの正規アクセスは、設定画面「高度な機能」で発行したAPIキー
// （Authorization: Bearer cfbk_... ヘッダ）でのみ許可する:
//
//   - キーは平文保存せずSHA-256ハッシュのみD1（api_keys表・0008）に保存する
//   - 認証のたびにキー照合+ユーザー行ロード（D1 read 2回。BAN・退会を即時反映）
//   - roleは常に"user"へ強制 → 管理API（requireAdmin）はAPIキーでは呼べない
//   - CSRF検証・Origin検査・パスワード変更失効（0007）の対象外
//     （Cookieを運ばないためCSRFの概念が無く、外部ツール運用を壊さないため）
//   - APIキーの作成/一覧/失効はブラウザログインでのみ可能（キーによる自立増殖防止）
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = "cfbk_";

// AuthorizationヘッダからAPIキーを取り出す。形状確認のみで実体検証はしない
// （無効なキーでもrequireSession内で401になる）。
export function apiKeyFromRequest(request: Request): string | null {
  const auth = request.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(cfbk_[A-Za-z0-9_-]{40,})$/);
  return m ? m[1]! : null;
}

export function isApiKeyRequest(request: Request): boolean {
  return apiKeyFromRequest(request) !== null;
}

// APIキーを検証し、SessionRecordへ詰め替える。無効/退会済みならnull。
async function getSessionFromApiKey(env: Env, rawKey: string): Promise<SessionRecord | null> {
  const keyHash = await sha256Hex(rawKey);
  const row = await getApiKeyByHash(env.DB_MAIN, keyHash);
  if (!row) return null;
  const user = await getUserById(env.DB_MAIN, row.user_id);
  if (!user) return null; // 退会済み（users行が無い）
  if (user.status === "banned") {
    throw new ApiError(
      403,
      "banned",
      user.ban_reason ? `アカウントが停止されています: ${user.ban_reason}` : "アカウントが停止されています"
    );
  }
  // last_used_atは60秒に1回まで更新（読み取り系ツールでのD1 write消費を防ぐ）
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    try {
      await touchApiKeyLastUsed(env.DB_MAIN, row.key_id, now);
    } catch {
      /* 設定画面の表示値なので更新失敗は無視 */
    }
  }
  return {
    session_id: `apikey:${row.key_id}`,
    user_id: row.user_id,
    email: user.email,
    role: "user", // 管理APIはAPIキーでは使えない（ブラウザログインのみ）
    csrf_secret: "",
    created_at: row.created_at,
    last_seen_at: now,
    authVia: "apikey",
  };
}

// セッション失効チェック（マイグレーション0007）。
// パスワード変更（管理者による再設定 / 設定画面での自己変更）は
// users.sessions_invalidated_at へ変更時刻（UNIX秒）を記録する。それ以前に
// 発行されたセッション（JWT=iat / HMAC=セッション行作成時刻）をここで拒否する。
// 発行時刻の粒度は秒（JWTのiat）のため、「変更と同一秒に発行されたトークン」は
// 猶予扱いとする（設定画面での自己変更直後に再発行されるトークンを保護するため。
// 管理者再設定の場合も残る猶予は最大1秒で実害は無い）。
//
// 【設計上のポイント】ユーザー行をロードする書き込み系API（投稿・アカウント変更・
// 管理操作等）からのみ呼び出すため、JWTモードでもD1読み取りは増えない
// （閲覧系は従来どおり署名検証のみ = JWTの「ストレージ消費ゼロ」は維持）。
// 公開データの閲覧はログイン不要のため、失効した古いトークンが残っていても
// 読み取りだけできても実害がない。
export function assertSessionNotRevoked(session: SessionRecord, user: Pick<UserRecord, "sessions_invalidated_at">): void {
  // APIキーはパスワード変更の影響を受けない（外部ツールの運用を壊さないため）。
  // 失効手段は「設定画面でのキー削除」「BAN」「退会」の3つ。
  if (session.authVia === "apikey") return;
  const revokedAt = user.sessions_invalidated_at;
  if (revokedAt != null && session.created_at < revokedAt * 1000) {
    throw new ApiError(
      401,
      "session_revoked",
      "パスワードが変更されたため、このセッションは失効しました。ログインし直してください"
    );
  }
}

export async function requireSession(env: Env, request: Request): Promise<SessionRecord> {
  // APIキー（Bearer）優先。キーが付いていればCookieは見ない（外部ツールは
  // Cookie無しで呼ぶため。キーが無効ならここで401になる）。
  const rawKey = apiKeyFromRequest(request);
  if (rawKey) {
    const session = await getSessionFromApiKey(env, rawKey);
    if (!session) throw new ApiError(401, "invalid_api_key", "APIキーが無効か、取り消されています");
    return session;
  }
  const session = await getSessionFromRequest(env, request);
  if (!session) throw new ApiError(401, "unauthorized", "ログインが必要です");
  return session;
}

export function requireAdmin(session: SessionRecord): void {
  // クライアント側の値は一切信用せず、常にサーバー側(セッションストア=KV)の
  // role値のみで権限判定する。
  if (session.role !== "admin") {
    throw new ApiError(403, "forbidden", "管理者権限が必要です");
  }
}

// Origin検証（v11で厳格化・「既定で外部ツール拒否」の本体）。
//
// 【設計】ブラウザは同一OriginへのPOST/PATCH/PUT/DELETEで必ずOriginヘッダを
// 付ける（fetch仕様）。一方curl等の外部ツールは通常付けないため、
// 「書き込み系リクエストにOrigin/Refererが無い=外部ツール」とみなして403にする。
// 外部ツールからの正規アクセスは設定画面で発行したAPIキー（Authorization: Bearer）
// を使う。この場合ブラウザではないためOriginを要求しない。
//
// - APIキーリクエスト → 無条件で通す（キー自体の検証はrequireSessionで行う）
// - GET/HEAD → 従来どおり検査しない（ブラウザは同一OriginのGETにOriginを付けない。
//   公開データの閲覧はログイン不要なので実害も無い）
// - Origin/Refererどちらも無い書き込み → 403 external_tool_blocked
// - ある場合 → PRIMARY/BACKUPドメインまたは同一ホストのみ許可
//   （同一ホスト許可はworkers.dev直接アクセス・wrangler dev・Host設定不備の
//    緩和のため。Backupドメインへのフェイルオーバーは「ページ=Primary・
//    送信先=Backup」でもOrigin=Primaryになるためallowedで許可される）
export function requireValidOrigin(env: Env, request: Request): void {
  if (isApiKeyRequest(request)) return;
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return;

  const source = request.headers.get("Origin") || request.headers.get("Referer");
  if (!source) {
    throw new ApiError(
      403,
      "external_tool_blocked",
      "このAPIはブラウザからのみ利用できます。外部ツールからは設定画面（高度な機能）で発行したAPIキーを Authorization: Bearer ヘッダで送信してください"
    );
  }
  let host: string;
  try {
    host = new URL(source).host;
  } catch {
    throw new ApiError(403, "invalid_origin", "不正なOriginです");
  }
  const allowed = new Set([env.PRIMARY_API_DOMAIN, env.BACKUP_API_DOMAIN]);
  let requestHost = "";
  try {
    requestHost = new URL(request.url).host;
  } catch {
    /* request.urlは常に有効だが安全側で空文字のまま比較させる */
  }
  if (!allowed.has(host) && host !== requestHost) {
    throw new ApiError(403, "invalid_origin", "許可されていないOriginです");
  }
}

// CSRF検証（v2: JWT対応）。HMACの対象は「検証済みJWTから取り出したjti」。
// 旧実装（Cookieの生値=KV上のsession_idをHMAC対象にする方式）と同等の強度を持ち、
// 秘密鍵(CSRF_HMAC_SECRET)を知らない第三者はjtiを知り得ないため偽造できない。
export async function requireCsrf(env: Env, request: Request, session: SessionRecord): Promise<void> {
  // APIキー（Bearer）はCookieを運ばないためCSRFの概念が存在しない（v11）。
  if (session.authVia === "apikey") return;
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  if (!(await verifyCsrfToken(env, session.session_id, headerToken))) {
    throw new ApiError(403, "csrf_invalid", "CSRFトークンが不正です");
  }
}

// Content-Typeの厳格チェック（application/json以外を拒否）。
export function requireJsonContentType(request: Request): void {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Typeはapplication/jsonである必要があります");
  }
}

// 巨大なRequest Bodyを拒否する。Content-Lengthが無い場合もあるため、
// 実際の読み取り時に別途上限を掛けて多重に防御する（呼び出し側で
// request.text()の長さをチェックすること）。
export function requireContentLengthWithin(request: Request, maxBytes: number): void {
  const len = request.headers.get("Content-Length");
  if (len && Number(len) > maxBytes) {
    throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  }
}
