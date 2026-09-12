// サーバー群（複数の独立したcf-bbs Worker）の健全性監視と情報共有。
//
// 要件（ユーザー仕様）:
//   - 既存サーバーのダウン確認と新規サーバーの情報共有は毎日 0:00(JST) に、
//     「前日のアクセスが少なかった順」に選ばれた最大3サーバー（総サーバー数が
//     3以下の場合は全サーバー）が担当して全サーバーのレスポンスチェックを行う。
//   - 担当選定に使うアクセス統計は各サーバーが毎日23:59(JST)に共有する。
//     0:00までに統計を転送してこなかったサーバーは（レート制限等の可能性が
//     あるため）チェック担当にしない。
//   - 担当サーバーは0:01(JST)にチェック結果を全サーバーへ公開（push）する。
//     他のサーバーは担当サーバーから結果を取得（pull）して自分のDBを更新する。
//   - 新規サーバーの登録は JWT/HMAC（KVを使わない認証）で行い、登録された
//     サーバーは即時に他のサーバーへ配信する（announce + ブートストラップは
//     src/routes/servers.ts の addServerCore が担当）。
//
// 実装の前提:
//   - 全サーバーで同じ SYNC_SECRET を設定していること（HMAC署名でサーバー間APIを認証）。
//   - 各サーバーは Cron Trigger を持ち、wrangler.toml の3本のcronで動く:
//       59 14 * * *  → 23:59 JST  自分のアクセス統計を共有（scheduledPublishAccessStats）
//        0 15 * * *  →  0:00 JST  担当サーバーのみ全サーバーをチェック（scheduledRunHealthChecks）
//        1 15 * * *  →  0:01 JST  担当=結果をpush / 非担当=担当からpull（scheduledDistributeReport）
//   - 担当選定は「23:59に共有された統計」から全サーバーが同一アルゴリズムで
//     決定できる（決定論的）。統計が何も無い初日に限り自分自身が担当となる
//     （フォールバック。小規模ネットワークでは二重チェックが起きても害はない）。
//
// 【Free Plan上の制約】 サブリクエスト上限（50/リクエスト）のため、1回のcronで
// チェック/通知できる相手は最大40サーバーに制限している（MAX_PEERS_PER_RUN）。

import { ApiError, type Env, type ServerHealth, type ServerType } from "../types";
import {
  listAccessStatsForDate,
  listKnownServers,
  pruneOldAccessStats,
  recordAccessStat,
  updateServerHealth,
  upsertKnownServer,
  setServerDeadDays,
  deleteKnownServer,
  normalizeServerType,
} from "../db/queries";
import { readAndResetDailyRequestCounter } from "../utils/cacheCounter";
import { guardAgainstAbuse } from "../utils/dosGuard";
import { jsonResponse } from "../utils/response";
import { buildSyncHeaders, sleep, syncSend, verifySyncRequest } from "../utils/clusterSync";
import { getAdminSettings } from "../utils/settings";
import { jstDayKey, pingHealth } from "../utils/serverHealth";
import { selfDescriptor } from "./servers";

// 1回のcron実行で扱う相手サーバーの上限（Free Planのサブリクエスト上限対策）
const MAX_PEERS_PER_RUN = 40;
// チェック担当の数（総サーバー数が3以下の場合は全員が担当）
const CHECKER_COUNT = 3;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

// pingHealth（GET /api/health での生存確認）と jstDayKey（JST日付キー）は
// 管理画面の手動レスポンスチェック（servers.ts）と共通の判定基準を使うため
// src/utils/serverHealth.ts へ移設した（v11.2）。このファイルでもそれを使う。

function normalizeHealthValue(raw: unknown): ServerHealth {
  return raw === "up" || raw === "down" ? raw : "unknown";
}

function isValidHttpsOrigin(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.pathname.slice(1) && !u.search && !u.hash;
  } catch {
    return false;
  }
}

// 相手サーバーが生きているかの確認（pingHealth）は src/utils/serverHealth.ts の
// 共通実装を使う（日次cronと管理画面の手動チェックで同一基準・v11.2移設）。

// ---------------------------------------------------------------------------
// 担当サーバーの決定（全サーバーが同一アルゴリズムで同一結果を得る）
// ---------------------------------------------------------------------------

export interface CheckerDesignation {
  checkers: string[];
  selfUrl: string;
  day: string; // 対象となった統計の日付（JST）
}

export async function computeDesignatedCheckers(env: Env): Promise<CheckerDesignation> {
  const self = selfDescriptor(env);
  // 「0:00時点での前日」= JSTで24時間前の日付。cronが数分遅延しても安全なよう
  // さらに5分のマージンを引く。
  const day = jstDayKey(Date.now() - 24 * 3600 * 1000 - 5 * 60 * 1000);

  const [stats, peers] = await Promise.all([
    listAccessStatsForDate(env.DB_MAIN, day),
    listKnownServers(env.DB_MAIN),
  ]);
  const statMap = new Map(stats.map((s) => [s.server_url, s.request_count]));

  // 候補 = 23:59までに統計を共有してきたサーバーのみ（仕様: 統計未転送の
  // サーバーはレート制限等の可能性があるため担当にしない）
  const candidates: { url: string; count: number }[] = [];
  if (statMap.has(self.url)) candidates.push({ url: self.url, count: statMap.get(self.url)! });
  for (const p of peers) {
    if (statMap.has(p.url)) candidates.push({ url: p.url, count: statMap.get(p.url)! });
  }

  // フォールバック: 統計が一切無い（初日・全員失敗）場合は自分が担当になる
  if (candidates.length === 0) {
    return { checkers: [self.url], selfUrl: self.url, day };
  }

  // 前日アクセスが少なかった順（同数の場合はURLの辞書順で全員が同じ結果になるように）
  candidates.sort((a, b) => a.count - b.count || a.url.localeCompare(b.url));

  const totalServers = peers.length + 1; // 自分を含む総サーバー数
  const take = totalServers <= CHECKER_COUNT ? candidates.length : Math.min(CHECKER_COUNT, candidates.length);
  return { checkers: candidates.slice(0, take).map((c) => c.url), selfUrl: self.url, day };
}

// ---------------------------------------------------------------------------
// Cron: 23:59 JST — 自分の当日アクセス数を全サーバーへ共有
// ---------------------------------------------------------------------------

export async function scheduledPublishAccessStats(env: Env): Promise<string> {
  const self = selfDescriptor(env);
  // cronが14:59:00〜15:04くらいに発火しても「終わろうとしている日」を指すように
  // 5分のマージンを引いて日付を算出する。
  const day = jstDayKey(Date.now() - 5 * 60 * 1000);
  const count = await readAndResetDailyRequestCounter();

  // 自分の分もDBに記録（0:00の担当決定はこの表をソースにする）
  await recordAccessStat(env.DB_MAIN, self.url, day, count, Date.now());

  const peers = (await listKnownServers(env.DB_MAIN)).slice(0, MAX_PEERS_PER_RUN);
  const results = await Promise.allSettled(
    peers.map((p) =>
      syncSend(env.SYNC_SECRET, p.url, "POST", "/api/sync/access-stats", {
        senderUrl: self.url,
        statDate: day,
        requestCount: count,
        reportedAt: Date.now(),
      })
    )
  );
  const delivered = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;

  // 古い統計の掃除（7日より前を削除）
  await pruneOldAccessStats(env.DB_MAIN, jstDayKey(Date.now() - 7 * 86400 * 1000));

  return `stats shared: count=${count} delivered=${delivered}/${peers.length} day=${day}`;
}

// ---------------------------------------------------------------------------
// Cron: 0:00 JST — 担当サーバーが全サーバーの生存確認を行う
// ---------------------------------------------------------------------------

export async function scheduledRunHealthChecks(env: Env): Promise<string> {
  const { checkers, selfUrl } = await computeDesignatedCheckers(env);
  if (!checkers.includes(selfUrl)) {
    return `not designated (checkers=${checkers.join(",")})`;
  }

  const peers = (await listKnownServers(env.DB_MAIN)).slice(0, MAX_PEERS_PER_RUN);
  const now = Date.now();
  await Promise.allSettled(
    peers.map(async (p) => {
      const up = await pingHealth(p.url);
      // 自分で直接確認した結果をDBへ反映（upの場合はlast_up_atも更新）
      await updateServerHealth(env.DB_MAIN, p.url, up ? "up" : "down", now, null);
    })
  );
  return `checked ${peers.length} servers (checkers=${checkers.join(",")})`;
}

// ---------------------------------------------------------------------------
// Cron: 0:01 JST — 担当は結果をpush、非担当は担当からpull
//
// v10からは自動削除伝播をサポートするため、担当のうち先頭（checkers[0]・
// 全サーバーが同じアルゴリズムで決定できるため決定論的）を「集約者」。
//   - 集約者: 他の担当サーバーのチェック結果を取得し、サーバーごとに多数決
//     （2台以上がdown判定した日のみ「到達不能」とカウント）。
//     連続到達不能日数が server_auto_removal_days（既定3・管理画面で変更可）
//     に達したサーバーは自分のリストから削除し、全サーバーへ削除を伝播する。
//   - その他の担当: 自分のチェック結果をGET /api/sync/health-report で
//     集約者に提供するだけ（pushしない）。
//   - 非担当: 集約者からマージ済みレポートをpullして反映する。
//     マージ済みレポートには各サーバーの連続到達不能日数（deadDays）が含まれ、
//     受信側もしきい値に達した行を自分のリストから削除する（二重安全網）。
//   - 単独の報告しか得られなかったサーバーは日数カウントを進めない
//     （チェッカー1台の誤報で削除が進むのを防ぐ安全装置）。
//   - 復旧したサーバーは翌日以降の23:59統計共有（announce）で自然に再登録される。
export async function scheduledDistributeReport(env: Env): Promise<string> {
  const { checkers, selfUrl } = await computeDesignatedCheckers(env);
  const settings = await getAdminSettings(env);
  const threshold = settings.server_auto_removal_days;

  if (checkers.includes(selfUrl)) {
    if (checkers[0] !== selfUrl) {
      // 集約者以外の担当: 自分のチェック結果はGETで集約者から参照されるため
      // ここでは何もpushしない
      return `votes ready (aggregator=${checkers[0]})`;
    }

    // --- 集約者として動作 ---
    const own = await listKnownServers(env.DB_MAIN);
    interface VoteState {
      up: number;
      down: number;
      reports: number;
      entry: SyncServerEntry;
      prevDeadDays: number;
    }
    const votes = new Map<string, VoteState>();
    const now = Date.now();
    // 自分の0:00チェック結果を最初の1票として登録
    for (const r of own) {
      votes.set(r.url, {
        up: r.health === "up" ? 1 : 0,
        down: r.health === "down" ? 1 : 0,
        reports: 1,
        entry: toSyncServer(r),
        prevDeadDays: r.dead_days ?? 0,
      });
    }
    // 他の担当サーバーのチェック結果（=各サーバーのDB現状）を取得して票を合算
    for (const checker of checkers.slice(1, CHECKER_COUNT)) {
      let report: Awaited<ReturnType<typeof fetchReportFrom>> = null;
      for (let attempt = 0; attempt < 2 && !report; attempt++) {
        if (attempt > 0) await sleep(4000);
        report = await fetchReportFrom(checker, env);
      }
      if (!report || !Array.isArray(report.servers)) continue;
      for (const s of report.servers) {
        if (!isValidHttpsOrigin(s.url) || s.url === selfUrl) continue;
        const v = votes.get(s.url) ?? {
          up: 0,
          down: 0,
          reports: 0,
          entry: { ...s },
          prevDeadDays: 0,
        };
        v.reports += 1;
        if (s.health === "up") v.up += 1;
        else if (s.health === "down") v.down += 1;
        votes.set(s.url, v);
      }
    }

    // 集約判定・自動削除決定
    const removedUrls: string[] = [];
    const removedMeta: { url: string; deadDays: number }[] = [];
    const merged: SyncServerEntry[] = [];
    for (const [url, v] of votes) {
      const counted = v.reports >= 2; // 2台以上の報告が揃った日のみ日数カウントを進める
      const deadVote = counted && v.down >= 2; // 2台以上がdown判定した日のみ+1
      const deadDays = counted ? (deadVote ? v.prevDeadDays + 1 : 0) : v.prevDeadDays;
      if (deadDays >= threshold) {
        removedUrls.push(url);
        removedMeta.push({ url, deadDays });
        continue;
      }
      const health: ServerHealth = counted
        ? v.down >= 2 && v.down > v.up
          ? "down"
          : v.up > v.down
            ? "up"
            : "unknown"
        : normalizeHealthValue(v.entry.health);
      merged.push({ ...v.entry, health, deadDays });
    }

    // マージ結果を自分のDBへ反映
    for (const entry of merged) {
      await upsertKnownServer(env.DB_MAIN, entry.url, entry.name, now, normalizeServerType(entry.type));
      await setServerDeadDays(env.DB_MAIN, entry.url, entry.deadDays ?? 0, entry.health, now);
    }
    // 自動削除の実行（自分のリストから削除）
    for (const url of removedUrls) {
      await deleteKnownServer(env.DB_MAIN, url);
    }

    // マージ済みレポートを全サーバーへpush（削除済みサーバーは除外）
    const payload = { senderUrl: selfUrl, checkedAt: now, aggregated: true, servers: merged };
    const results = await Promise.allSettled(
      own.map((p) => syncSend(env.SYNC_SECRET, p.url, "POST", "/api/sync/health-report", payload))
    );
    const delivered = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;

    // 削除伝播（削除対象を全サーバーへ通知。自分は除外）
    let removedBroadcast = 0;
    if (removedUrls.length > 0) {
      const broadcast = await Promise.allSettled(
        own
          .filter((p) => p.url !== selfUrl)
          .map((p) =>
            syncSend(env.SYNC_SECRET, p.url, "POST", "/api/sync/server-removed", {
              senderUrl: selfUrl,
              servers: removedMeta,
            })
          )
      );
      removedBroadcast = broadcast.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    }
    return `aggregated (${checkers.length} checkers): merged=${merged.length} removed=${removedUrls.length} (broadcast=${removedBroadcast}/${own.length - 1}) delivered=${delivered}/${own.length}`;
  }

  // 非担当サーバー: 集約者からマージ済みレポートを取得して更新する（pull）。
  // 0:01に集約者の処理がまだ終わっていない可能性があるため、各担当につき
  // 最大2回・4秒間隔で再試行する。
  for (const checker of checkers.slice(0, CHECKER_COUNT)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await syncSend(env.SYNC_SECRET, checker, "GET", "/api/sync/health-report");
      if (result.ok) {
        const report = await fetchReportFrom(checker, env);
        if (report) {
          const applied = await applyServerHealthReport(env, report);
          return `pulled from ${checker}: applied ${applied} entries`;
        }
      }
      await sleep(4000);
    }
  }
  return `pull failed (checkers=${checkers.join(",")})`;
}

interface SyncServerEntry {
  url: string;
  name: string;
  type: string;
  health: ServerHealth;
  lastHealthAt: number | null;
  lastUpAt: number | null;
  // 連続到達不能日数（マージ済みレポートのみ含まれる。単独報告では undefined）
  deadDays?: number;
}

function toSyncServer(r: { url: string; name: string; type: ServerType; health: ServerHealth; last_health_at: number | null; last_up_at: number | null; dead_days?: number }): SyncServerEntry {
  return {
    url: r.url,
    name: r.name,
    type: r.type,
    health: r.health,
    lastHealthAt: r.last_health_at,
    lastUpAt: r.last_up_at,
    deadDays: r.dead_days ?? 0,
  };
}

async function fetchReportFrom(checkerUrl: string, env: Env): Promise<{ senderUrl?: string; checkedAt?: number; servers?: SyncServerEntry[] } | null> {
  try {
    const res = await fetch(`${checkerUrl}/api/sync/health-report`, {
      headers: await buildSyncHeaders(env.SYNC_SECRET, "GET", "/api/sync/health-report", ""),
    });
    if (!res.ok) return null;
    return (await res.json()) as { senderUrl?: string; checkedAt?: number; servers?: SyncServerEntry[] };
  } catch {
    return null;
  }
}

// 他サーバーから受け取った稼働状態を自分のDBへ反映する。
// 未知のURLが来た場合は「情報共有」の一環として新規採用する（上限は
// upsertKnownServer側で強制される）。
// aggregated=true（マージ済みレポート）の場合は各エントリのdeadDaysも反映し、
// しきい値（server_auto_removal_days）に達したサーバーを自分のリストからも
// 削除する（集約者からの削除broadcastが届かなかった場合の二重安全網）。
// aggregated=false（単独報告）の場合はdeadDaysを変更しない（日数カウントは
// 2台以上の報告が揃った日のみ進む。誤報防止の安全装置）。
async function applyServerHealthReport(
  env: Env,
  report: { senderUrl?: string; checkedAt?: number; aggregated?: boolean; servers?: SyncServerEntry[] }
): Promise<number> {
  const self = selfDescriptor(env);
  const now = Date.now();
  let applied = 0;
  const servers = Array.isArray(report.servers) ? report.servers.slice(0, MAX_PEERS_PER_RUN) : [];
  const threshold = report.aggregated ? (await getAdminSettings(env)).server_auto_removal_days : Infinity;

  for (const s of servers) {
    if (!isValidHttpsOrigin(s.url) || s.url === self.url) continue;
    const health = normalizeHealthValue(s.health);
    if (report.aggregated && typeof s.deadDays === "number" && s.deadDays >= threshold) {
      // 全サーバーで自動削除が決まったサーバー。自分のリストからも除外する
      await deleteKnownServer(env.DB_MAIN, s.url);
      applied++;
      continue;
    }
    // 未知のサーバーは採用してから状態を反映する（サーバー一覧の緩やかな共有）
    await upsertKnownServer(env.DB_MAIN, s.url, (s.name || s.url).slice(0, 60), now, normalizeServerType(s.type));
    if (report.aggregated && typeof s.deadDays === "number") {
      await setServerDeadDays(env.DB_MAIN, s.url, s.deadDays, health, typeof s.lastHealthAt === "number" ? s.lastHealthAt : now);
    } else {
      await updateServerHealth(env.DB_MAIN, s.url, health, typeof s.lastHealthAt === "number" ? s.lastHealthAt : now, typeof s.lastUpAt === "number" ? s.lastUpAt : null);
    }
    applied++;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// HTTPエンドポイント（サーバー間API・HMAC署名必須 / 公開ヘルスチェック）
// ---------------------------------------------------------------------------

// GET /api/health — 公開。生存確認用の最小レスポンス。
export async function handleHealth(env: Env, request: Request): Promise<Response> {
  await guardAgainstAbuse(request, "health", 1);
  const self = selfDescriptor(env);
  return jsonResponse({
    ok: true,
    name: self.name,
    time: Date.now(),
  });
}

async function readSyncBody(request: Request, maxBytes: number): Promise<string> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "リクエストボディが大きすぎます");
  }
  return text;
}

// POST /api/sync/access-stats — 23:59に各サーバーが自分のアクセス数を共有する
export async function handleSyncAccessStats(env: Env, request: Request): Promise<Response> {
  const raw = await readSyncBody(request, 4096);
  try {
    await verifySyncRequest(env.SYNC_SECRET, request, raw);
  } catch (err) {
    throw syncAuthError(err);
  }
  let body: { senderUrl?: string; statDate?: string; requestCount?: number; reportedAt?: number };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }

  if (!isValidHttpsOrigin(body.senderUrl)) {
    throw new ApiError(400, "invalid_sender", "senderUrlが不正です");
  }
  if (typeof body.statDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.statDate)) {
    throw new ApiError(400, "invalid_stat_date", "statDateはYYYY-MM-DD形式で指定してください");
  }
  const count = Math.max(0, Math.floor(Number(body.requestCount ?? 0)));
  if (!Number.isFinite(count)) {
    throw new ApiError(400, "invalid_count", "requestCountが不正です");
  }
  const reportedAt = typeof body.reportedAt === "number" ? body.reportedAt : Date.now();
  await recordAccessStat(env.DB_MAIN, body.senderUrl, body.statDate, count, reportedAt);
  return jsonResponse({ ok: true });
}

// POST /api/sync/health-report — 担当サーバーからのチェック結果の公開（push）
export async function handleSyncHealthReportPost(env: Env, request: Request): Promise<Response> {
  const raw = await readSyncBody(request, 32 * 1024);
  try {
    await verifySyncRequest(env.SYNC_SECRET, request, raw);
  } catch (err) {
    throw syncAuthError(err);
  }
  let body: { senderUrl?: string; checkedAt?: number; servers?: SyncServerEntry[] };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
  if (!isValidHttpsOrigin(body.senderUrl)) {
    throw new ApiError(400, "invalid_sender", "senderUrlが不正です");
  }
  const applied = await applyServerHealthReport(env, body);
  return jsonResponse({ ok: true, applied });
}

// GET /api/sync/health-report — 担当サーバーから結果を取得（pull）
export async function handleSyncHealthReportGet(env: Env, request: Request): Promise<Response> {
  try {
    await verifySyncRequest(env.SYNC_SECRET, request, "");
  } catch (err) {
    throw syncAuthError(err);
  }
  const self = selfDescriptor(env);
  const rows = (await listKnownServers(env.DB_MAIN)).slice(0, MAX_PEERS_PER_RUN);
  return jsonResponse({
    senderUrl: self.url,
    checkedAt: Date.now(),
    servers: rows.map(toSyncServer),
  });
}

// POST /api/sync/server-list — サーバー一覧の取り込み（新規サーバーへの
// ブートストラップ配信などに使う。HMAC署名必須）。
export async function handleSyncServerList(env: Env, request: Request): Promise<Response> {
  const raw = await readSyncBody(request, 32 * 1024);
  try {
    await verifySyncRequest(env.SYNC_SECRET, request, raw);
  } catch (err) {
    throw syncAuthError(err);
  }
  let body: { senderUrl?: string; servers?: { url?: string; name?: string; type?: string }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
  if (!isValidHttpsOrigin(body.senderUrl)) {
    throw new ApiError(400, "invalid_sender", "senderUrlが不正です");
  }

  const self = selfDescriptor(env);
  const now = Date.now();
  let accepted = 0;
  const servers = Array.isArray(body.servers) ? body.servers.slice(0, MAX_PEERS_PER_RUN) : [];
  for (const s of servers) {
    if (!isValidHttpsOrigin(s.url) || s.url === self.url) continue;
    const ok = await upsertKnownServer(env.DB_MAIN, s.url, (s.name || s.url).slice(0, 60), now, normalizeServerType(s.type));
    if (ok) accepted++;
  }
  return jsonResponse({ ok: true, accepted });
}

// POST /api/sync/server-removed — 自動削除の伝播（集約者からの通知。
// HMAC署名必須）。対象を自分の既知サーバーリストから削除する。
// 自分自身（senderUrl含むurl === 自分）は削除しない（誤報・自己防衛）。
export async function handleSyncServerRemoved(env: Env, request: Request): Promise<Response> {
  const raw = await readSyncBody(request, 16 * 1024);
  try {
    await verifySyncRequest(env.SYNC_SECRET, request, raw);
  } catch (err) {
    throw syncAuthError(err);
  }
  let body: { senderUrl?: string; servers?: { url?: string; deadDays?: number }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONの形式が不正です");
  }
  if (!isValidHttpsOrigin(body.senderUrl)) {
    throw new ApiError(400, "invalid_sender", "senderUrlが不正です");
  }

  const self = selfDescriptor(env);
  let removed = 0;
  const entries = Array.isArray(body.servers) ? body.servers.slice(0, MAX_PEERS_PER_RUN) : [];
  for (const s of entries) {
    if (!isValidHttpsOrigin(s.url) || s.url === self.url) continue;
    await deleteKnownServer(env.DB_MAIN, s.url);
    removed++;
  }
  return jsonResponse({ ok: true, removed });
}

function syncAuthError(err: unknown): ApiError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "sync_disabled") {
    return new ApiError(503, "sync_disabled", "サーバー間同期が無効です（SYNC_SECRETを設定してください）");
  }
  if (msg === "sync_timestamp_out_of_range") {
    return new ApiError(401, "sync_timestamp_invalid", "署名の有効期限が切れています");
  }
  return new ApiError(401, "sync_unauthorized", "サーバー間認証に失敗しました");
}
