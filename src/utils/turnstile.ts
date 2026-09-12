import type { Env } from "../types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyResult {
  ok: boolean;
  // siteverifyが返したerror-codes（タイムアウト・使用済みなどの判別用）。
  // トークン空やsiteverify到達失敗など、コードが無い場合はこちらで補完する。
  errors: string[];
}

export async function verifyTurnstileDetailed(env: Env, token: string | undefined, remoteIp: string): Promise<TurnstileVerifyResult> {
  if (!token) return { ok: false, errors: ["missing-input-response"] };
  const body = new URLSearchParams();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return {
      ok: data.success === true,
      errors: Array.isArray(data["error-codes"]) ? data["error-codes"] : [],
    };
  } catch (err) {
    console.error("Turnstile verify failed:", err);
    // siteverify自体に届かなかった場合。ユーザー側の再試行で復帰し得るため
    // 汎用メッセージ（リトライ促す）につながるコード扱いにする
    return { ok: false, errors: ["verification-unreachable"] };
  }
}

export async function verifyTurnstile(env: Env, token: string | undefined, remoteIp: string): Promise<boolean> {
  return (await verifyTurnstileDetailed(env, token, remoteIp)).ok;
}

// siteverifyのエラーコードをユーザー向けの案内メッセージへ変換する。
// Turnstileのトークンは1回の検証で消費されるため、リクエストが何らかの理由で
// 失敗した後に同じトークンを再送すると timeout-or-duplicate で必ず失敗する
// （フロントエンドは失敗後にウィジェットをresetして新しいトークンを取得する。
// このメッセージはその案内と対応している）。
export function turnstileUserMessage(errors: string[]): string {
  if (errors.includes("timeout-or-duplicate")) {
    return "Turnstileのトークンが期限切れまたは使用済みです。もう一度送信してください";
  }
  if (errors.includes("missing-input-response")) {
    return "Turnstileの認証トークンを取得できませんでした。ページを再読み込みするか、少し待ってからもう一度お試しください";
  }
  if (errors.includes("invalid-input-secret")) {
    return "Turnstileのサーバー設定が不正です（シークレットキーを確認してください）";
  }
  return "Turnstile検証に失敗しました。もう一度お試しください";
}
