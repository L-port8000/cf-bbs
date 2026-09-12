// 最小限の JWT (JWS compact / HS256) 実装。
//
// なぜ JWT（ステートレスセッション）へ移行するのか:
//   - Workers KV Free Planの書き込み上限は 1,000回/日（アカウント全体）。
//     従来はログイン成功のたびにKV write 1回、認証が必要なAPIのたびに
//     KV read 1回を消費していた。
//   - JWTなら署名検証はCPU上のHMAC計算のみで完結し、KV/D1へのアクセスが
//     一切不要。ログイン時・投稿時・閲覧時のいずれもストレージ消費ゼロ。
//
// 署名秘密鍵は SESSION_HMAC_SECRET を再利用する（新シークレットの追加設定を
// 増やさないため。値自体はセッションID生成時にも使っていたランダム文字列と
// は別物で、HMAC鍵として十分な長さを前提とする — README参照）。
//
// 【トレードオフ（既知の制約）】 ステートレス化により「サーバー側からの完全な
// 即時失効」はJWT単体ではできなくなる:
//   - ログアウト = Cookieの削除のみ。トークン自体は期限切れまで技術的には有効
//     （ただしHttpOnly Cookieから取り出せない限り使いようがない）。
//   - BANは「次回の投稿時（D1でstatusを再確認）」「次回のログイン時」に反映。
//     投稿処理はBAN状態をD1から都度確認するため、JWTが残っていても投稿は不可能。
//   - role の変更（admin付与/剥奪）は再ログイン後に反映（旧KV実装と同じ挙動）。
//   - 【0007で強化】パスワード変更（管理者再設定 / 自己変更）は
//     users.sessions_invalidated_at が記録され、それ以前の iat のトークンは
//     書き込み系API・/me で即時拒否される（詳細はsrc/middleware/auth.ts参照）。

import type { UserRole } from "../types";
import { hmacSign } from "./crypto";
import { timingSafeEqualStr } from "./crypto";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface JwtPayload {
  // subject = user_id
  sub: string;
  email: string;
  role: UserRole;
  // JWT ID。CSRFトークンのHMAC対象に使う（旧session_idの役割を引き継ぐ）
  jti: string;
  iat: number; // 発行時刻（UNIX秒）
  exp: number; // 失効時刻（UNIX秒）
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

function decodeSegment(segment: string): unknown {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(textDecoder.decode(bytes));
}

// トークンを発行する。失敗（秘密鍵未設定等）時は例外を投げる（ログインを失敗させる方が安全）。
export async function signJwt(secret: string, payload: JwtPayload): Promise<string> {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson(payload);
  const signingInput = `${header}.${body}`;
  const signature = await hmacSign(secret, signingInput);
  return `${signingInput}.${signature}`;
}

// トークンを検証する。署名不一致・期限切れ・形式不正・クレーム不足のいずれかでも
// nullを返す（呼び出し側は401として扱う）。
export async function verifyJwt(secret: string, token: string | undefined): Promise<JwtPayload | null> {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  let expected: string;
  try {
    expected = await hmacSign(secret, `${header}.${body}`);
  } catch {
    return null;
  }
  if (!timingSafeEqualStr(expected, signature)) return null;

  try {
    const headerObj = decodeSegment(header) as { alg?: string };
    if (headerObj?.alg !== "HS256") return null;
    const payload = decodeSegment(body) as Partial<JwtPayload>;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.email !== "string") return null;
    if (payload.role !== "user" && payload.role !== "admin") return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0) return null;
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    // 期限チェック（60秒の_clock_skew余裕を持たせる）
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec - 60) return null;
    return payload as JwtPayload;
  } catch {
    return null;
  }
}
