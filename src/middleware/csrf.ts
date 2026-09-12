// CSRF対策。「Double Submit Cookie」と「Session紐付けToken」の両方の性質を
// 併せ持つステートレス実装:
//
//   csrf_token = HMAC-SHA256(CSRF_HMAC_SECRET, session_id)
//
// ログイン時にHttpOnlyな session cookie とは別に、JSから読み取り可能な
// 非HttpOnly Cookie `bbs_csrf` としてこの値をクライアントへ渡す。
// フロントエンドは状態変更リクエスト時にこの値を `X-CSRF-Token` ヘッダへ
// 載せて送信する。サーバー側はHttpOnly session cookieから得たsession_idを
// 元にHMACを再計算し、ヘッダの値と一致するかを検証する。
//
// - 単純なCookie値の一致だけを見る素朴なDouble Submit Cookieと異なり、
//   秘密鍵(CSRF_HMAC_SECRET)を知らない第三者はsession_idからcsrf_token を
//   偽造できない（Session紐付けTokenの性質）。
// - KVやD1へトークンを保存する必要がないため、追加の書き込みコストが
//   発生しない。

import type { Env } from "../types";
import { hmacSign, hmacVerify } from "../utils/crypto";

export const CSRF_COOKIE_NAME = "bbs_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

export async function issueCsrfToken(env: Env, sessionId: string): Promise<string> {
  return hmacSign(env.CSRF_HMAC_SECRET, sessionId);
}

export async function verifyCsrfToken(env: Env, sessionId: string, providedToken: string | null): Promise<boolean> {
  if (!providedToken) return false;
  return hmacVerify(env.CSRF_HMAC_SECRET, sessionId, providedToken);
}
