// Cache API (caches.default) を用いたRate Limit実装。
//
// なぜKVでもDurable Objectsでもなく Cache API を使うのか:
//   - Workers KV Free Planの書き込み上限は "1,000回/日"（アカウント全体で共有）
//     しかなく、投稿のたびにKVを書き込む設計では現実的なユーザー数ですぐに
//     枯渇する。KVはセッション作成（ログイン成功時のみ）に温存する。
//   - Durable Objectsは無料枠自体はあるものの、アカウントによっては
//     デプロイ時に「Durable Objectsの利用には料金プランへの同意が必要」
//     という趣旨の確認を求められることがあり、追加の支払い設定に関する
//     摩擦が生じる場合がある（実際にR2で同様の事情により利用できなかった
//     という経緯を踏まえ、本プロジェクトでは採用しない）。
//   - Cache APIはWorkers Free Planで追加設定なしに利用でき、TTL(max-age)に
//     よる自動失効の仕組みがRate Limitの「時間窓」と自然に噛み合う。
//
// 【既知の制約】 Cache APIはデータセンター（Cloudflareの各拠点）単位で
// 動作し、KVやDurable Objectsのような強い一貫性は提供しない。そのため、
// 理論上は複数の異なる拠点から同時にリクエストが送られた場合、日次上限や
// 投稿間隔が厳密に1回も超過なく強制されるとは限らない（ごくわずかな
// 超過が起こり得るソフトな制限）。BBSの投稿制限としては現実的に十分な
// 精度であり、KVの書き込み枠の制約や追加のプラン同意を避けられる
// メリットの方が大きいと判断した。より厳密な制御が必要な場合は
// Durable Objects等への置き換えを検討すること。

const RL_HOST = "https://rl.internal.cf-bbs.invalid";

function cacheKeyRequest(path: string): Request {
  return new Request(`${RL_HOST}${path}`);
}

async function cacheGetJson<T>(req: Request): Promise<T | null> {
  const cache = caches.default;
  const res = await cache.match(req);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function cachePutJson(req: Request, value: unknown, maxAgeSec: number): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${Math.max(1, Math.floor(maxAgeSec))}`,
    },
  });
  await cache.put(req, res);
}

async function cacheDelete(req: Request): Promise<void> {
  const cache = caches.default;
  await cache.delete(req);
}

// 日次カウンタの「1日の区切り」。JST 0:03 とする。
// 0:00〜0:02は死活監視シーケンス（23:59統計→0:00チェック→0:01公布）の
// 実行中のため、その通信を前日に含めず、監視完了後に新しい1日を開始する。
// TTLが切れたCacheエントリは自動で失効するため、読み出し忘れても翌日の
// 0:03には自動で0に戻る。
function secondsUntilJstDailyBoundary(now: number): number {
  // JST 0:03 = UTC 15:03。JST時刻に見立てた値の秒内位置から残り秒を算出
  const jstShiftedSec = Math.floor((now + (9 * 3600 - 3 * 60) * 1000) / 1000);
  return 86400 - (jstShiftedSec % 86400);
}

// ---------------------------------------------------------------------------
// 投稿間隔（短時間Rate Limit）
// ---------------------------------------------------------------------------

export interface IntervalCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export async function checkAndConsumeInterval(key: string, minIntervalSec: number): Promise<IntervalCheckResult> {
  const req = cacheKeyRequest(`/interval/${encodeURIComponent(key)}`);
  const now = Date.now();
  const state = await cacheGetJson<{ postedAt: number }>(req);

  if (state) {
    const elapsed = now - state.postedAt;
    const minIntervalMs = minIntervalSec * 1000;
    if (elapsed < minIntervalMs) {
      return { allowed: false, retryAfterMs: minIntervalMs - elapsed };
    }
  }

  await cachePutJson(req, { postedAt: now }, minIntervalSec);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// 1日の投稿数上限（Daily Limit）
// ---------------------------------------------------------------------------

export interface DailyCheckResult {
  allowed: boolean;
  dailyCount: number;
  dailyRemaining: number;
}

export async function checkAndIncrementDaily(key: string, dailyLimit: number): Promise<DailyCheckResult> {
  const req = cacheKeyRequest(`/daily/${encodeURIComponent(key)}`);
  const now = Date.now();
  const state = await cacheGetJson<{ count: number }>(req);
  const count = state?.count ?? 0;

  if (count >= dailyLimit) {
    return { allowed: false, dailyCount: count, dailyRemaining: 0 };
  }

  const nextCount = count + 1;
  // 「1日」の区切りは JST 0:03（死活監視シーケンス完了後に新しい日を開始）
  await cachePutJson(req, { count: nextCount }, secondsUntilJstDailyBoundary(now));
  return { allowed: true, dailyCount: nextCount, dailyRemaining: Math.max(0, dailyLimit - nextCount) };
}

// ---------------------------------------------------------------------------
// 日次アクセスカウンタ（サーバー全体の合算値）。
// 23:59(JST)に他サーバーへ共有し、翌0:00のヘルスチェック担当サーバー選定
// （前日アクセスが少なかった順）に使う。Cache APIのみで完結し、KV/D1の
// 消費はゼロ。TTL（明示リセット漏れ時のフォールバック）はJST 0:03で失効する
// ため、23:59の読み出し忘れがあっても監視シーケンス完了後（0:03）には
// 自動で0に戻る。
// ---------------------------------------------------------------------------

export async function incrementDailyRequestCounter(): Promise<void> {
  const req = cacheKeyRequest("/meta/daily-requests");
  const state = await cacheGetJson<{ count: number }>(req);
  await cachePutJson(req, { count: (state?.count ?? 0) + 1 }, secondsUntilJstDailyBoundary(Date.now()));
}

// 読み出すと同時にリセットする（23:59の統計共有で使用）。
export async function readAndResetDailyRequestCounter(): Promise<number> {
  const req = cacheKeyRequest("/meta/daily-requests");
  const state = await cacheGetJson<{ count: number }>(req);
  await cacheDelete(req);
  return state?.count ?? 0;
}

// ---------------------------------------------------------------------------
// ログイン試行のブルートフォース／クレデンシャルスタッフィング対策
// ---------------------------------------------------------------------------

const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15分間の失敗回数を見る
const AUTH_MAX_FAILURES = 8; // このウィンドウ内でこの回数を超えたらロック
const AUTH_BASE_LOCKOUT_MS = 30 * 1000; // 初回ロックは30秒
const AUTH_MAX_LOCKOUT_MS = 30 * 60 * 1000; // 最大30分まで指数的に延長
const AUTH_STATE_TTL_SEC = 2 * 60 * 60; // 状態自体のCache保持期間（窓+最大ロック時間を包含）

interface AuthGuardState {
  windowStart: number;
  failCount: number;
  lockedUntil: number;
  consecutiveLockouts: number;
}

export interface AuthGuardCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export async function checkAuthGuard(key: string): Promise<AuthGuardCheckResult> {
  const req = cacheKeyRequest(`/auth-guard/${encodeURIComponent(key)}`);
  const state = await cacheGetJson<AuthGuardState>(req);
  const now = Date.now();
  if (state && state.lockedUntil > now) {
    return { allowed: false, retryAfterMs: state.lockedUntil - now };
  }
  return { allowed: true };
}

export async function recordAuthResult(key: string, success: boolean): Promise<void> {
  const req = cacheKeyRequest(`/auth-guard/${encodeURIComponent(key)}`);

  if (success) {
    await cacheDelete(req);
    return;
  }

  const now = Date.now();
  const state = (await cacheGetJson<AuthGuardState>(req)) ?? {
    windowStart: now,
    failCount: 0,
    lockedUntil: 0,
    consecutiveLockouts: 0,
  };

  let { windowStart, failCount, consecutiveLockouts } = state;
  if (now - windowStart > AUTH_WINDOW_MS) {
    windowStart = now;
    failCount = 0;
  }
  failCount += 1;

  let lockedUntil = 0;
  if (failCount >= AUTH_MAX_FAILURES) {
    const lockoutMs = Math.min(AUTH_BASE_LOCKOUT_MS * Math.pow(2, consecutiveLockouts), AUTH_MAX_LOCKOUT_MS);
    lockedUntil = now + lockoutMs;
    consecutiveLockouts += 1;
    failCount = 0;
    windowStart = now;
  }

  await cachePutJson(req, { windowStart, failCount, lockedUntil, consecutiveLockouts }, AUTH_STATE_TTL_SEC);
}
