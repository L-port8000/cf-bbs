// セッション管理（v2: KV廃止。JWT / HMACの2モード切替式）。
//
// 【KVの廃止について】 旧実装は「Cookie=ランダムSession ID、実体=KV」という
// 構成で、ログインのたびにKV write 1回（Free Plan上限1,000回/日）、全認証
// リクエストでKV read 1回を消費していた。v2ではKVを完全廃止し、管理画面で
// 選択可能な2つの認証方式（どちらもKV消費ゼロ）を実装した:
//
//   1) JWTモード (auth_mode='jwt'・既定)
//      - HttpOnly CookieにHS256署名済みJWTを保持（src/utils/jwt.ts参照）
//      - 検証はHMAC計算のみ → KV/D1消費ゼロ・最速
//      - 即時失効について（0007マイグレーションで強化）:
//        パスワード変更時刻 users.sessions_invalidated_at とトークン発行時刻(iat)を
//        突合し、書き込み系APIで古いトークンを401拒否。/me も未ログイン扱いにする。
//        閲覧系（公開データ）は署名検証のみのまま = D1読み取りゼロを維持。
//
//   2) HMACモード (auth_mode='hmac')
//      - Cookie=ランダムID（"sid_"接頭辞）、セッション実体=DB_MAINの
//        d1_sessions表（マイグレーション0005参照）
//      - 認証のたびにD1 read 1回（JWTモードより僅かに重いが、KVよりは
//        大幅に大きい無料枠：D1 read 500万行/日 vs KV read 10万回/日）
//      - ログアウト・BAN・role変更でセッションを即時削除できる（即時失効）
//      - CSRF検証はJWTモードと共通のHMAC方式（HMAC(CSRF_HMAC_SECRET, session_id)）
//
// モード判定はCookie値の形式（"sid_"接頭辞の有無）で行うため、設定を切り替えても
// 既存のログイン状態は有効期限まで継続し、新規ログインから新しい方式が使われる
// （検証時に設定読み取り＝D1アクセスを挟まずに済む設計）。

import type { Env, SessionRecord, UserRole } from "../types";
import { randomToken } from "../utils/crypto";
import { signJwt, verifyJwt } from "../utils/jwt";
import { getAdminSettings } from "../utils/settings";
import { deleteD1Session, getD1Session, insertD1Session } from "../db/queries";

export const SESSION_COOKIE_NAME = "bbs_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14日（旧KV実装と同じ）
const D1_SESSION_PREFIX = "sid_";

export type AuthTokenMode = "jwt" | "hmac";

// ログイン/登録時に呼び出す。管理画面の auth_mode 設定に従ってトークンを発行する。
// 戻り値の token をHttpOnly Cookieへ、sessionId をCSRF計算に使う。
export async function issueSessionToken(
  env: Env,
  userId: string,
  email: string,
  role: UserRole
): Promise<{ token: string; sessionId: string; mode: AuthTokenMode }> {
  let mode: AuthTokenMode = "jwt";
  try {
    const settings = await getAdminSettings(env);
    if (settings.auth_mode === "hmac") mode = "hmac";
  } catch {
    // 設定読み取りに失敗したら安全側（既定のJWTモード）で続行
  }

  if (mode === "hmac") {
    // Session Fixation対策としてランダムIDは毎回新規発行（旧KV実装と同じ方針）
    const sessionId = `${D1_SESSION_PREFIX}${randomToken(32)}`;
    const now = Date.now();
    await insertD1Session(env.DB_MAIN, {
      session_id: sessionId,
      user_id: userId,
      email,
      role,
      created_at: now,
      last_seen_at: now,
      expires_at: now + SESSION_TTL_SECONDS * 1000,
    });
    return { token: sessionId, sessionId, mode };
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionId = randomToken(16); // jti（CSRFのHMAC対象）
  const token = await signJwt(env.SESSION_HMAC_SECRET, {
    sub: userId,
    email,
    role,
    jti: sessionId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  });
  return { token, sessionId, mode };
}

// Cookie値を検証し、旧SessionRecordと同じ形へ詰め替える。
// - "sid_"接頭辞あり → HMACモード（D1 lookup 1回。期限切れ行は削除してnull扱い）
// - それ以外 → JWTモード（署名検証のみ・ストレージアクセスゼロ）
export async function getSession(env: Env, token: string | undefined): Promise<SessionRecord | null> {
  if (!token) return null;

  if (token.startsWith(D1_SESSION_PREFIX)) {
    const row = await getD1Session(env.DB_MAIN, token);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      // 期限切れ行はこの際ついでに掃除する（追加コストほぼゼロ）
      await deleteD1Session(env.DB_MAIN, token);
      return null;
    }
    return {
      session_id: row.session_id,
      user_id: row.user_id,
      email: row.email,
      role: row.role === "admin" ? "admin" : "user",
      csrf_secret: "",
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
    };
  }

  const payload = await verifyJwt(env.SESSION_HMAC_SECRET, token);
  if (!payload) return null;
  return {
    session_id: payload.jti,
    user_id: payload.sub,
    email: payload.email,
    role: payload.role,
    csrf_secret: "",
    created_at: payload.iat * 1000,
    last_seen_at: Date.now(),
  };
}

// ログアウト処理。HMACモードではD1上のセッション行を即時削除（失効の即時反映）。
// JWTモードではCookie削除に頼る（呼び出し側でSet-Cookieする）が、パスワード変更が
// 伴う場合は sessions_invalidated_at（0007）により書き込み系操作は即時失効する。
export async function revokeSession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  if (token.startsWith(D1_SESSION_PREFIX)) {
    await deleteD1Session(env.DB_MAIN, token);
  }
  // JWTモードはno-op（ステートレスなため・書き込み系の失効は0007の突合で行う）
}
