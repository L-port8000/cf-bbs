import { ApiError, type Env } from "./types";
import { errorResponse, jsonResponse, SECURITY_HEADERS } from "./utils/response";
import { handleLogin, handleLogout, handleMe, handleRegister, handleUpdateUsername, handleUpdateEmail, handleChangePassword, handleDeleteAccount, handleListApiKeys, handleCreateApiKey, handleRevokeApiKey } from "./routes/auth";
import { handleCreatePost, handleCreateThread, handleListPosts, handleListThreads } from "./routes/posts";
import {
  handleAdminListThreads,
  handleAuditLog,
  handleBanUser,
  handleGetSettings,
  handleModeratePost,
  handleModerateThread,
  handleMigrateShard,
  handlePurgeExpired,
  handlePurgeThread,
  handlePullFromBackup,
  handleSearchUsers,
  handleSetUserRole,
  handleUnbanUser,
  handleUpdateSettings,
  handleAdminOverview,
  handleAdminResetPassword,
  handlePurgeRegistrationIps,
} from "./routes/admin";
import {
  handleAdminAddServer,
  handleAdminCheckServer,
  handleAdminRemoveServer,
  handleAdminSyncPull,
  handleAnnounceServer,
  handleListServers,
  handleUserRegisterServer,
} from "./routes/servers";
import {
  handleHealth,
  handleSyncAccessStats,
  handleSyncHealthReportGet,
  handleSyncHealthReportPost,
  handleSyncServerList,
  handleSyncServerRemoved,
  scheduledDistributeReport,
  scheduledPublishAccessStats,
  scheduledRunHealthChecks,
} from "./routes/cluster";
import { handleStatus } from "./routes/status";
import { runDailyMaintenance } from "./db/sharding";
import { getAdminSettings } from "./utils/settings";
import { incrementDailyRequestCounter } from "./utils/cacheCounter";
import { purgeExpiredD1Sessions } from "./db/queries";

const MAX_GLOBAL_BODY_BYTES = 1_000_000; // 1MB — 全APIに対する巨大Body拒否の最終防波堤

// クロスオリジンで「読み取り専用」に公開してよいエンドポイント。
// 複数サーバー選択機能で、他サーバーの掲示板をインライン表示するために
// 認証情報(Cookie)無しでの閲覧を許可する。状態変更を伴うAPIやセッション情報を
// 含むAPIは絶対にここへ含めないこと。
function isPubliclyReadableGet(pathname: string, method: string): boolean {
  if (method !== "GET") return false;
  if (pathname === "/api/public-config") return true;
  if (pathname === "/api/servers") return true;
  if (pathname === "/api/threads") return true;
  if (pathname === "/api/health") return true;
  if (/^\/api\/threads\/\d+\/posts$/.test(pathname)) return true;
  return false;
}

function corsHeadersFor(env: Env, request: Request, pathname: string): HeadersInit {
  const origin = request.headers.get("Origin");
  const method = request.headers.get("Access-Control-Request-Method") ?? request.method;

  if (isPubliclyReadableGet(pathname, method)) {
    // 認証情報を伴わない単純GETなので、任意オリジンからの閲覧を許可してよい
    // （Access-Control-Allow-Credentialsは付与しない＝Cookieは一切共有されない）。
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
  }

  const allowed = new Set([`https://${env.PRIMARY_API_DOMAIN}`, `https://${env.BACKUP_API_DOMAIN}`]);
  if (origin && allowed.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      Vary: "Origin",
    };
  }
  return {};
}

function withCors(response: Response, env: Env, request: Request, pathname: string): Response {
  const cors = corsHeadersFor(env, request, pathname);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v as string);
  return new Response(response.body, { status: response.status, headers });
}

function checkHostHeader(env: Env, request: Request): void {
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== "production") return;
  const allowedHosts = new Set([env.PRIMARY_API_DOMAIN, env.BACKUP_API_DOMAIN]);
  // workers.dev のデフォルトプレビュードメインは初期セットアップ確認用に許可する
  if (url.hostname.endsWith(".workers.dev")) return;
  if (!allowedHosts.has(url.hostname)) {
    throw new ApiError(400, "invalid_host", "不正なHostヘッダです");
  }
}

async function routeApi(env: Env, request: Request, ctx: ExecutionContext, pathname: string): Promise<Response> {
  const method = request.method;

  if (pathname === "/api/public-config" && method === "GET") {
    // Turnstile要件のフラグも返す（フロントエンドがトークン未取得のまま
    // 送信して必ず失敗するリクエストを事前に防げるようにするため）。
    // 設定読み取りに失敗してもconfig配信自体は止めない（既定値で代替）。
    const settings = await getAdminSettings(env).catch(() => null);
    return jsonResponse({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      primaryDomain: env.PRIMARY_API_DOMAIN,
      backupDomain: env.BACKUP_API_DOMAIN,
      deploymentRole: env.DEPLOYMENT_ROLE,
      turnstileOnAuth: settings ? settings.require_turnstile_on_auth : true,
      turnstileOnPost: settings ? settings.require_turnstile_on_post : false,
    });
  }

  if (pathname === "/api/auth/register" && method === "POST") return handleRegister(env, request);
  if (pathname === "/api/auth/login" && method === "POST") return handleLogin(env, request);
  if (pathname === "/api/auth/logout" && method === "POST") return handleLogout(env, request);
  if (pathname === "/api/auth/me" && method === "GET") return handleMe(env, request);
  if (pathname === "/api/auth/username" && method === "PATCH") return handleUpdateUsername(env, request);
  // 設定画面（アカウントセルフサービス）: いずれも現在パスワード再入力+CSRF必須
  if (pathname === "/api/auth/email" && method === "PATCH") return handleUpdateEmail(env, request);
  if (pathname === "/api/auth/password" && method === "POST") return handleChangePassword(env, request);
  if (pathname === "/api/auth/delete-account" && method === "POST") return handleDeleteAccount(env, request);

  // APIキー管理（v11新設: 設定「高度な機能」。発行/一覧/失効はブラウザログイン限定。
  // APIキー（Bearer）によるキー管理・管理APIは拒否される。詳細は routes/auth.ts 参照）
  if (pathname === "/api/auth/api-keys" && method === "GET") return handleListApiKeys(env, request);
  if (pathname === "/api/auth/api-keys" && method === "POST") return handleCreateApiKey(env, request);
  const apiKeyMatch = pathname.match(/^\/api\/auth\/api-keys\/([A-Za-z0-9_-]+)$/);
  if (apiKeyMatch && method === "DELETE") return handleRevokeApiKey(env, request, apiKeyMatch[1]!);

  if (pathname === "/api/threads" && method === "GET") return handleListThreads(env, request, ctx);
  if (pathname === "/api/threads" && method === "POST") return handleCreateThread(env, request);

  let m: RegExpMatchArray | null;

  if ((m = pathname.match(/^\/api\/threads\/(\d+)\/posts$/))) {
    const threadId = Number(m[1]);
    if (method === "GET") return handleListPosts(env, request, ctx, threadId);
    if (method === "POST") return handleCreatePost(env, request, threadId);
  }

  // --- Admin ---
  if (pathname === "/api/admin/users" && method === "GET") return handleSearchUsers(env, request);

  // --- 利用状況（/status）。管理者に限らずログイン済み全ユーザーが閲覧できる ---
  if (pathname === "/api/status" && method === "GET") return handleStatus(env, request, ctx);
  // 旧パス（/api/admin/status）も後方互換用エイリアスとして残す
  if (pathname === "/api/admin/status" && method === "GET") return handleStatus(env, request, ctx);

  // --- 管理画面「スレッド」タブ（一覧・ID検索・完全削除） ---
  if (pathname === "/api/admin/threads" && method === "GET") return handleAdminListThreads(env, request);
  if ((m = pathname.match(/^\/api\/admin\/threads\/(\d+)\/purge$/)) && method === "POST") {
    return handlePurgeThread(env, request, Number(m[1]));
  }

  if ((m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/ban$/)) && method === "POST") {
    return handleBanUser(env, request, m[1]!);
  }
  if ((m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/unban$/)) && method === "POST") {
    return handleUnbanUser(env, request, m[1]!);
  }
  if ((m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/)) && method === "POST") {
    return handleSetUserRole(env, request, m[1]!);
  }
  // 管理者によるパスワード再設定（仮パスワード自動生成対応・v10新設）
  if ((m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/)) && method === "POST") {
    return handleAdminResetPassword(env, request, m[1]!);
  }
  // 登録IPの一括消去（プライバシー・v10新設）
  if (pathname === "/api/admin/privacy/purge-registration-ips" && method === "POST") {
    return handlePurgeRegistrationIps(env, request);
  }

  if ((m = pathname.match(/^\/api\/admin\/threads\/(\d+)\/posts\/(\d+)\/(hide|unhide|delete)$/)) && method === "POST") {
    const threadId = Number(m[1]);
    const postId = Number(m[2]);
    const action = m[3] as "hide" | "unhide" | "delete";
    return handleModeratePost(env, request, threadId, postId, action);
  }

  if ((m = pathname.match(/^\/api\/admin\/threads\/(\d+)\/(hide|unhide|delete)$/)) && method === "POST") {
    const threadId = Number(m[1]);
    const action = m[2] as "hide" | "unhide" | "delete";
    return handleModerateThread(env, request, threadId, action);
  }

  if (pathname === "/api/admin/settings" && method === "GET") return handleGetSettings(env, request);
  if (pathname === "/api/admin/settings" && method === "PUT") return handleUpdateSettings(env, request);
  if (pathname === "/api/admin/audit-log" && method === "GET") return handleAuditLog(env, request);
  if (pathname === "/api/admin/migrate-shard" && method === "POST") return handleMigrateShard(env, request);
  if (pathname === "/api/admin/purge-expired" && method === "POST") return handlePurgeExpired(env, request);
  if (pathname === "/api/admin/sync/pull-from-backup" && method === "POST") return handlePullFromBackup(env, request);
  if (pathname === "/api/admin/overview" && method === "GET") return handleAdminOverview(env, request);

  // --- 複数サーバー選択機能 ---
  if (pathname === "/api/servers" && method === "GET") return handleListServers(env, request);
  if (pathname === "/api/servers/register" && method === "POST") return handleUserRegisterServer(env, request);
  if (pathname === "/api/servers/announce" && method === "POST") return handleAnnounceServer(env, request);
  if (pathname === "/api/admin/servers" && method === "POST") return handleAdminAddServer(env, request);
  if (pathname === "/api/admin/servers/check" && method === "POST") return handleAdminCheckServer(env, request);
  if (pathname === "/api/admin/servers/remove" && method === "POST") return handleAdminRemoveServer(env, request);
  if (pathname === "/api/admin/servers/sync-pull" && method === "POST") return handleAdminSyncPull(env, request);

  // --- サーバー間同期（HMAC署名必須）・生存確認 ---
  if (pathname === "/api/health" && method === "GET") return handleHealth(env, request);
  if (pathname === "/api/sync/access-stats" && method === "POST") return handleSyncAccessStats(env, request);
  if (pathname === "/api/sync/health-report" && method === "POST") return handleSyncHealthReportPost(env, request);
  if (pathname === "/api/sync/health-report" && method === "GET") return handleSyncHealthReportGet(env, request);
  if (pathname === "/api/sync/server-list" && method === "POST") return handleSyncServerList(env, request);
  // サーバー自動削除の伝播（集約者からの通知・v10新設）
  if (pathname === "/api/sync/server-removed" && method === "POST") return handleSyncServerRemoved(env, request);

  throw new ApiError(404, "not_found", "エンドポイントが見つかりません");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      checkHostHeader(env, request);

      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, { status: 204, headers: corsHeadersFor(env, request, url.pathname) });
      }

      if (url.pathname.startsWith("/api/")) {
        // 日次アクセスカウンタ（23:59の統計共有・ヘルスチェック担当選定用）。
        // Cache APIのみで完結しKV/D1の消費はゼロ。応答を待たせないようwaitUntilで後方実行。
        if (request.method !== "OPTIONS") {
          ctx.waitUntil(incrementDailyRequestCounter().catch(() => {}));
        }
        const contentLength = request.headers.get("Content-Length");
        if (contentLength && Number(contentLength) > MAX_GLOBAL_BODY_BYTES) {
          throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
        }
        const response = await routeApi(env, request, ctx, url.pathname);
        return withCors(response, env, request, url.pathname);
      }

      // 静的フロントエンド（public/）へフォールバック
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      return new Response(assetResponse.body, { status: assetResponse.status, headers });
    } catch (err) {
      return withCors(errorResponse(err), env, request, url.pathname);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // cronは3本（Free Planの上限内）:
    //   "59 14 * * *" = 23:59 JST  アクセス統計の共有 + 日次メンテナンス + 期限切れセッション掃除
    //    "0 15 * * *" =  0:00 JST  担当サーバーが全サーバーの生存確認
    //    "1 15 * * *" =  0:01 JST  結果の公開(push)と取得(pull)
    const cron = event.cron;

    if (cron === "59 14 * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            console.log("[cron 23:59 JST]", await scheduledPublishAccessStats(env));
          } catch (err) {
            console.error("access stats sharing failed:", err);
          }
          try {
            // 日次メンテナンス（移行チェーン・保持期間削除は db_shard_count 設定に従う）
            const settings = await getAdminSettings(env);
            const logs = await runDailyMaintenance(env, settings);
            console.log("[cron 23:59 JST] maintenance:", logs.join(" / "));
          } catch (err) {
            console.error("scheduled maintenance failed:", err);
          }
          try {
            // HMACセッションモードの期限切れセッション掃除（D1 write 1回/日）
            await purgeExpiredD1Sessions(env.DB_MAIN, Date.now());
          } catch (err) {
            console.error("d1 session purge failed:", err);
          }
        })()
      );
      return;
    }

    if (cron === "0 15 * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            console.log("[cron 0:00 JST]", await scheduledRunHealthChecks(env));
          } catch (err) {
            console.error("health check failed:", err);
          }
        })()
      );
      return;
    }

    if (cron === "1 15 * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            console.log("[cron 0:01 JST]", await scheduledDistributeReport(env));
          } catch (err) {
            console.error("report distribution failed:", err);
          }
        })()
      );
      return;
    }

    // 未知のcronは従来のメンテナンスとして扱う（wrangler.tomlを書き換えた
    // 直後の過渡期に古いスケジュールが残っていても安全に動くように）。
    ctx.waitUntil(
      (async () => {
        try {
          const settings = await getAdminSettings(env);
          await runDailyMaintenance(env, settings);
        } catch (err) {
          console.error("scheduled maintenance failed:", err);
        }
      })()
    );
  },
};
