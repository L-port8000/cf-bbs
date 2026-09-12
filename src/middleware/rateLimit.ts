import type { Env, UserTier } from "../types";
import { getAdminSettings } from "../utils/settings";
import {
  checkAndConsumeInterval,
  checkAndIncrementDaily,
  checkAuthGuard,
  recordAuthResult,
} from "../utils/cacheCounter";

// 投稿のRate Limit結果（呼び出し元 src/routes/posts.ts が参照する形）。
export interface PostRateLimitResult {
  allowed: boolean;
  reason?: "interval" | "daily_limit";
  retryAfterMs?: number;
  dailyCount?: number;
  dailyRemaining?: number;
}

// user_id と tier(新規/通常) を組み合わせてCache APIベースのRate Limitを
// チェックする。IPのみで識別しないことで、複数アカウントを使ったRate Limit
// 回避が user_id 単位の制限まで無効化されることを防ぐ（各アカウントごとに
// 独立して制限がかかる。多数アカウント作成自体は register 側のTurnstile・
// AuthGuardで抑止する）。
export async function checkPostRateLimit(env: Env, userId: string, tier: UserTier): Promise<PostRateLimitResult> {
  const settings = await getAdminSettings(env);
  const minIntervalSec = tier === "regular" ? settings.min_interval_regular_sec : settings.min_interval_new_sec;
  const dailyLimit = tier === "regular" ? settings.daily_limit_regular : settings.daily_limit_new;

  const interval = await checkAndConsumeInterval(`user:${userId}`, minIntervalSec);
  if (!interval.allowed) {
    return { allowed: false, reason: "interval", retryAfterMs: interval.retryAfterMs };
  }

  const daily = await checkAndIncrementDaily(`user:${userId}`, dailyLimit);
  if (!daily.allowed) {
    return { allowed: false, reason: "daily_limit", dailyCount: daily.dailyCount, dailyRemaining: 0 };
  }

  return { allowed: true, dailyCount: daily.dailyCount, dailyRemaining: daily.dailyRemaining };
}

// ログイン/登録試行のガード。IPとメールアドレスの双方を独立してチェックする。
export async function guardAuthAttempt(
  env: Env,
  ip: string,
  email: string
): Promise<{
  allowed: boolean;
  retryAfterMs?: number;
  recordResult: (success: boolean) => Promise<void>;
}> {
  void env; // Cache APIベースのため env は現状不要（将来の拡張に備えてシグネチャは維持）
  const ipKey = `ip:${ip}`;
  const emailKey = `email:${email.toLowerCase()}`;

  const [byIp, byEmail] = await Promise.all([checkAuthGuard(ipKey), checkAuthGuard(emailKey)]);

  const allowed = byIp.allowed && byEmail.allowed;
  const retryAfterMs = Math.max(byIp.retryAfterMs ?? 0, byEmail.retryAfterMs ?? 0);

  return {
    allowed,
    retryAfterMs: allowed ? undefined : retryAfterMs,
    recordResult: async (success: boolean) => {
      await Promise.all([recordAuthResult(ipKey, success), recordAuthResult(emailKey, success)]);
    },
  };
}

export function getClientIp(request: Request): string {
  // Cloudflareが付与するヘッダ。単独の認証手段としては使わないが、
  // レート制限の識別要素の一つとしては妥当。
  return request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
}
