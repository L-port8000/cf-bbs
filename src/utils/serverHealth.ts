// サーバー（遠隔のcf-bbsデプロイ）の稼働確認に関わる共通処理。
//
// 使い所:
//   - src/routes/cluster.ts      日次ヘルスチェック（cron・0:00 JST）
//   - src/routes/servers.ts      管理画面の手動レスポンスチェック（v11.2）と
//                                サーバー追加時の実在確認後の稼働済み登録
//
// cluster.ts → servers.ts のimport関係があるため（selfDescriptor）、
// 両方から参照される関数はここに置いて循環importを避ける。

// ヘルスチェック1回あたりのタイムアウト
const HEALTH_TIMEOUT_MS = 8000;

// 管理画面の手動レスポンスチェックの1日あたり上限（管理者ごと・JST日替わり）。
// ユーザー要望「一日10回くらい使える」の本体。サーバー追加時の自動確認は対象外。
export const DAILY_RESPONSE_CHECK_LIMIT = 10;

// 手動レスポンスチェックの割当アクション名（admin_daily_quotas.action）
export const QUOTA_ACTION_SERVER_CHECK = "server_response_check";

// JST（UTC+9）の日付キー。統計のstat_dateと1日制限のdayに使う。
export function jstDayKey(ts: number): string {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 相手サーバーが生きているかを軽量エンドポイント（GET /api/health）で確認する。
// 日次cronと手動チェックの両方がこの関数を使うことで「稼働中/応答なし」の
// 判定基準を完全に同一に保つ。
export async function pingHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
