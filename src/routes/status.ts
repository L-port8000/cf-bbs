// /status: D1・KV・WorkersのFree Plan利用率（推定）を表示するための
// エンドポイント（ログイン済みの全ユーザーが閲覧できる。要望仕様）。
//
// 【重要】 Cloudflareの管理系API（GraphQL Analytics API / D1 Admin API）を
// 呼び出すため、通常のWorkerランタイムのシークレットとは別に、
// Account Analytics:Read（+ D1:Read）権限を持つAPIトークン(CF_API_TOKEN)と
// アカウントID(CF_ACCOUNT_ID)の設定が必要。未設定の場合はこの機能全体を
// 「未設定」として扱い、他機能には一切影響しない（要追加設定として
// READMEに明記）。
//
// 【既知の制約】 GraphQL Analytics APIのデータセット・フィールド名は
// Cloudflare側の仕様変更で変わることがある。本実装はWorkersのリクエスト数
// (workersInvocationsAdaptive)とD1のストレージ使用量(D1 Admin APIの
// file_size)は比較的安定した情報源のため信頼度が高いが、D1の
// 読み取り/書き込みクエリ数やKVの操作回数(d1AnalyticsAdaptiveGroups /
// kvOperationsAdaptiveGroups)はフィールド名の変更に弱く、取得に失敗した
// 場合はその項目だけ「取得できませんでした」として返す（全体を失敗させない）。
// 実際に動作しない場合はCloudflareダッシュボードの現在のGraphQLスキーマを
// 確認し、本ファイルのクエリを調整すること。

import { type Env } from "../types";
import { requireSession, requireValidOrigin } from "../middleware/auth";
import { jsonResponse } from "../utils/response";
import { guardAgainstAbuse } from "../utils/dosGuard";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const STATUS_CACHE_KEY = "https://rl.internal.cf-bbs.invalid/status-snapshot";
const STATUS_CACHE_TTL_SEC = 300; // 5分。無駄にCloudflare APIを叩かないための共有キャッシュ

// Free Plan既知の上限（2026年9月時点。Cloudflare公式ドキュメントで
// 変更されていないか随時確認すること）。
const LIMITS = {
  workersRequestsPerDay: 100_000,
  d1StorageBytesPerDb: 5 * 1024 * 1024 * 1024,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  kvReadsPerDay: 100_000,
  kvWritesPerDay: 1_000,
};

function isConfigured(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

async function cfManagementGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  const data = (await res.json()) as any;
  if (!res.ok || data.success === false) {
    throw new Error(`Cloudflare API error (${res.status}): ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.result;
}

async function cfGraphql(env: Env, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${CF_API_BASE}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = (await res.json()) as any;
  if (!res.ok || data.errors) {
    throw new Error(`Cloudflare GraphQL error: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.data;
}

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function getWorkersUsage(env: Env): Promise<{ requestsToday: number; limit: number; percent: number } | { error: string }> {
  try {
    const query = `
      query WorkersUsage($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(
              limit: 1
              filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
            ) {
              sum { requests }
            }
          }
        }
      }`;
    const data = await cfGraphql(env, query, {
      accountTag: env.CF_ACCOUNT_ID,
      scriptName: env.WORKER_SCRIPT_NAME,
      since: startOfUtcDayIso(),
      until: new Date().toISOString(),
    });
    const requestsToday = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum?.requests ?? 0;
    return {
      requestsToday,
      limit: LIMITS.workersRequestsPerDay,
      percent: Math.round((requestsToday / LIMITS.workersRequestsPerDay) * 1000) / 10,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface D1DbUsage {
  binding: string;
  storageBytes?: number;
  storagePercent?: number;
  rowsReadToday?: number;
  rowsWrittenToday?: number;
  rowsReadPercent?: number;
  rowsWrittenPercent?: number;
  error?: string;
}

async function getD1Usage(env: Env): Promise<D1DbUsage[]> {
  const targets: Array<{ binding: string; id: string }> = [
    { binding: "DB_MAIN", id: env.DB_MAIN_ID },
    { binding: "DB_SHARD_1", id: env.DB_SHARD_1_ID },
    { binding: "DB_SHARD_2", id: env.DB_SHARD_2_ID },
  ];

  const results: D1DbUsage[] = [];
  for (const t of targets) {
    if (!t.id) {
      results.push({ binding: t.binding, error: "database_idが未設定です（wrangler.toml参照）" });
      continue;
    }
    const usage: D1DbUsage = { binding: t.binding };
    try {
      const info = await cfManagementGet(env, `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${t.id}`);
      const bytes = info?.file_size ?? 0;
      usage.storageBytes = bytes;
      usage.storagePercent = Math.round((bytes / LIMITS.d1StorageBytesPerDb) * 1000) / 10;
    } catch (err) {
      usage.error = err instanceof Error ? err.message : String(err);
    }

    try {
      const query = `
        query D1Usage($accountTag: string!, $databaseId: string!, $since: Time!, $until: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              d1AnalyticsAdaptiveGroups(
                limit: 1
                filter: { databaseId: $databaseId, datetime_geq: $since, datetime_leq: $until }
              ) {
                sum { readQueries writeQueries }
              }
            }
          }
        }`;
      const data = await cfGraphql(env, query, {
        accountTag: env.CF_ACCOUNT_ID,
        databaseId: t.id,
        since: startOfUtcDayIso(),
        until: new Date().toISOString(),
      });
      const sum = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups?.[0]?.sum;
      if (sum) {
        const rowsRead = sum.readQueries ?? 0;
        const rowsWritten = sum.writeQueries ?? 0;
        usage.rowsReadToday = rowsRead;
        usage.rowsWrittenToday = rowsWritten;
        usage.rowsReadPercent = Math.round((rowsRead / LIMITS.d1RowsReadPerDay) * 1000) / 10;
        usage.rowsWrittenPercent = Math.round((rowsWritten / LIMITS.d1RowsWrittenPerDay) * 1000) / 10;
      }
    } catch {
      // rows read/writtenは取得できなくてもstorageの情報だけ返す（部分的成功を許容）
    }

    results.push(usage);
  }
  return results;
}

async function getKvUsage(env: Env): Promise<{ readsToday?: number; writesToday?: number; readPercent?: number; writePercent?: number; error?: string }> {
  if (!env.SESSIONS_KV_ID) {
    return { error: "KV Namespace IDが未設定です（wrangler.toml参照）" };
  }
  try {
    const query = `
      query KvUsage($accountTag: string!, $namespaceId: string!, $since: Time!, $until: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            kvOperationsAdaptiveGroups(
              limit: 10
              filter: { namespaceId: $namespaceId, datetime_geq: $since, datetime_leq: $until }
            ) {
              sum { requests }
              dimensions { actionType }
            }
          }
        }
      }`;
    const data = await cfGraphql(env, query, {
      accountTag: env.CF_ACCOUNT_ID,
      namespaceId: env.SESSIONS_KV_ID,
      since: startOfUtcDayIso(),
      until: new Date().toISOString(),
    });
    const groups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }> =
      data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
    let reads = 0;
    let writes = 0;
    for (const g of groups) {
      const type = (g.dimensions?.actionType ?? "").toLowerCase();
      if (type.includes("read") || type.includes("get")) reads += g.sum.requests;
      else if (type.includes("write") || type.includes("put")) writes += g.sum.requests;
    }
    return {
      readsToday: reads,
      writesToday: writes,
      readPercent: Math.round((reads / LIMITS.kvReadsPerDay) * 1000) / 10,
      writePercent: Math.round((writes / LIMITS.kvWritesPerDay) * 1000) / 10,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleStatus(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  requireValidOrigin(env, request);
  // 管理者に限らず、ログイン済みの全ユーザーが閲覧できる（要望仕様）。
  // 内容にはセッション固有の情報は含まれないため、共有キャッシュも安全に使える。
  await requireSession(env, request);
  // GET専用の読み取りエンドポイントのためCSRFトークンは要求しない
  // （CSRF対策は状態変更APIにのみ適用する方針。README参照）。

  await guardAgainstAbuse(request, "status", 3);

  const cache = caches.default;
  const cacheReq = new Request(STATUS_CACHE_KEY);
  const cached = await cache.match(cacheReq);
  if (cached) return cached;

  if (!isConfigured(env)) {
    const response = jsonResponse({
      configured: false,
      message: "CF_API_TOKEN / CF_ACCOUNT_ID が未設定のため利用率を取得できません（README参照）",
    });
    return response;
  }

  const [workers, d1, kv] = await Promise.all([getWorkersUsage(env), getD1Usage(env), getKvUsage(env)]);

  const body = { configured: true, generatedAt: Date.now(), workers, d1, kv };
  const response = jsonResponse(body, {
    headers: { "Cache-Control": `private, max-age=${STATUS_CACHE_TTL_SEC}` },
  });
  ctx.waitUntil(cache.put(cacheReq, response.clone()));
  return response;
}
