// BBS本体の投稿Rate Limit（src/utils/cacheCounter.ts）とは別枠の、
// 新規追加エンドポイント（/api/status, /api/servers 系）向けの軽量DoS対策。
// 「BBSの方は行わない」という要望どおり、投稿・スレッド関連のAPIには
// 一切適用しない。IPベースの短時間インターバル制限のみを提供する
// （既存のcacheCounter.tsの仕組みをそのまま再利用する薄いラッパー）。

import { ApiError } from "../types";
import { checkAndConsumeInterval } from "./cacheCounter";
import { getClientIp } from "../middleware/rateLimit";

export async function guardAgainstAbuse(request: Request, bucket: string, minIntervalSec: number): Promise<void> {
  const ip = getClientIp(request);
  const result = await checkAndConsumeInterval(`dos:${bucket}:${ip}`, minIntervalSec);
  if (!result.allowed) {
    const sec = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    throw new ApiError(429, "too_many_requests", `リクエストが多すぎます。${sec}秒後に再度お試しください`);
  }
}
