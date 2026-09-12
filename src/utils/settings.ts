// admin_settings (D1) をハードコードせず読み込むためのユーティリティ。
// 毎リクエストD1を読むとRead回数が嵩むため、Isolateプロセス内メモリに
// 短時間（既定30秒）キャッシュする。
//
// 【既知の制約】 このキャッシュはWorker Isolateごとに独立しており、
// 複数Isolateにまたがる伝播は保証されない（設定変更が全世界へ反映され
// きるまで最大30秒程度のばらつきが生じ得る）。強い一貫性が必要な場合は
// KVやDurable Objectへの置き換えを検討すること。

import type { AdminSettings, AuthTokenMode, Env } from "../types";

const CACHE_TTL_MS = 30_000;

let cached: { value: AdminSettings; expiresAt: number } | null = null;

const DEFAULTS: AdminSettings = {
  daily_limit_new: 50,
  daily_limit_regular: 300,
  min_interval_new_sec: 30,
  min_interval_regular_sec: 5,
  max_body_len: 200,
  max_urls: 5,
  promotion_distinct_days: 3,
  require_turnstile_on_post: false,
  require_turnstile_on_auth: true,
  data_retention_days: 730,
  username_min_len: 1,
  username_max_len: 20,
  username_daily_change_limit: 5,
  password_max_len: 20,
  // 登録時にIPアドレスを記録するか（既定OFF。プライバシー優先のデフォルト）
  record_registration_ip: false,
  // 連続到達不能日数がこの値に達した既知サーバーを自動削除する（1〜7日・既定3）
  server_auto_removal_days: 3,
  // 認証方式。"jwt" = ステートレスJWT（ストレージ消費ゼロ） /
  // "hmac" = D1保存セッション（1リクエストD1 read 1回・即時失効可）。
  // KVはどちらのモードでも使用しない（廃止）。
  auth_mode: "jwt" as AuthTokenMode,
  // 使用するD1の数（1〜3）。シャード移行・自動削除の挙動が変わる（README §10参照）。
  // 1 = DB_MAINのみ（移行なし・保持期間超過分はmainから直接削除）
  // 2 = main→shard1へ移行、保持期間超過分はshard1から削除
  // 3 = main→shard1→shard2へ移行、保持期間超過分はshard2から削除
  db_shard_count: 3,
};

export async function getAdminSettings(env: Env, forceRefresh = false): Promise<AdminSettings> {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.value;
  }

  const res = await env.DB_MAIN.prepare("SELECT key, value FROM admin_settings").all<{ key: string; value: string }>();
  const rows = res.results ?? [];
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const value: AdminSettings = {
    daily_limit_new: numOr(map.get("daily_limit_new"), DEFAULTS.daily_limit_new),
    daily_limit_regular: numOr(map.get("daily_limit_regular"), DEFAULTS.daily_limit_regular),
    min_interval_new_sec: numOr(map.get("min_interval_new_sec"), DEFAULTS.min_interval_new_sec),
    min_interval_regular_sec: numOr(map.get("min_interval_regular_sec"), DEFAULTS.min_interval_regular_sec),
    max_body_len: numOr(map.get("max_body_len"), DEFAULTS.max_body_len),
    max_urls: numOr(map.get("max_urls"), DEFAULTS.max_urls),
    promotion_distinct_days: numOr(map.get("promotion_distinct_days"), DEFAULTS.promotion_distinct_days),
    require_turnstile_on_post: boolOr(map.get("require_turnstile_on_post"), DEFAULTS.require_turnstile_on_post),
    require_turnstile_on_auth: boolOr(map.get("require_turnstile_on_auth"), DEFAULTS.require_turnstile_on_auth),
    data_retention_days: numOr(map.get("data_retention_days"), DEFAULTS.data_retention_days),
    username_min_len: numOr(map.get("username_min_len"), DEFAULTS.username_min_len),
    username_max_len: numOr(map.get("username_max_len"), DEFAULTS.username_max_len),
    username_daily_change_limit: numOr(
      map.get("username_daily_change_limit"),
      DEFAULTS.username_daily_change_limit
    ),
    password_max_len: numOr(map.get("password_max_len"), DEFAULTS.password_max_len),
    record_registration_ip: boolOr(map.get("record_registration_ip"), DEFAULTS.record_registration_ip),
    server_auto_removal_days: clampInt(map.get("server_auto_removal_days"), 1, 7, DEFAULTS.server_auto_removal_days),
    auth_mode: map.get("auth_mode") === "hmac" ? "hmac" : "jwt",
    db_shard_count: clampInt(map.get("db_shard_count"), 1, 3, DEFAULTS.db_shard_count),
  };

  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function setAdminSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB_MAIN.prepare(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, Date.now())
    .run();
  cached = null; // このIsolateのキャッシュは即時無効化する
}

function numOr(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Math.floor(numOr(v, fallback));
  return Math.min(max, Math.max(min, n));
}

function boolOr(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}
