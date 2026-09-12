// サーバー間（Worker⇔別Worker）同期通信の共通ユーティリティ。
//
// 認証方式: 共有シークレット SYNC_SECRET によるHMAC-SHA256署名。
//   X-Sync-Timestamp: リクエスト時刻(ms)
//   X-Sync-Signature: base64url(HMAC-SHA256(SYNC_SECRET, `${timestamp}:${method}:${path}:${body}`))
//
// タイムスタンプを署名対象に含めることでリプレイ攻撃を緩和し（±5分の受付窓）、
// ボディを含めることで改ざんを防ぐ。GETの場合 body は空文字列。
//
// 【前提】 SYNC_SECRET は全参加サーバーで同じ値を `wrangler secret put` しておく
// こと（README「複数サーバー選択機能」参照）。未設定の場合、受信側は503を返し、
// 送信側は送信をスキップする（機能全体が無効になる）。

import { hmacSign, timingSafeEqualStr } from "./crypto";

export const SYNC_TIMESTAMP_HEADER = "X-Sync-Timestamp";
export const SYNC_SIGNATURE_HEADER = "X-Sync-Signature";
const SYNC_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 署名の有効窓（±5分）

export async function buildSyncHeaders(secret: string, method: string, path: string, body: string): Promise<HeadersInit> {
  const timestamp = String(Date.now());
  const signature = await hmacSign(secret, `${timestamp}:${method.toUpperCase()}:${path}:${body}`);
  return {
    "Content-Type": "application/json",
    [SYNC_TIMESTAMP_HEADER]: timestamp,
    [SYNC_SIGNATURE_HEADER]: signature,
  };
}

// 受信側の検証。失敗理由は例外メッセージで区別する。
export async function verifySyncRequest(
  secret: string,
  request: Request,
  rawBody: string
): Promise<void> {
  if (!secret) {
    throw new Error("sync_disabled");
  }
  const timestamp = request.headers.get(SYNC_TIMESTAMP_HEADER) ?? "";
  const signature = request.headers.get(SYNC_SIGNATURE_HEADER) ?? "";
  if (!timestamp || !signature) {
    throw new Error("missing_sync_signature");
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SYNC_TIMESTAMP_TOLERANCE_MS) {
    throw new Error("sync_timestamp_out_of_range");
  }
  const path = new URL(request.url).pathname;
  const expected = await hmacSign(secret, `${timestamp}:${request.method.toUpperCase()}:${path}:${rawBody}`);
  if (!timingSafeEqualStr(expected, signature)) {
    throw new Error("invalid_sync_signature");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SyncSendResult {
  ok: boolean;
  status?: number;
}

// ベストエフォートの送信。相手が落ちていても例外を投げない（cron/announceの
// 性質上、1サーバーの失敗で全体を止めてはいけない）。SYNC_SECRET未設定時は
// 何もせず false を返す。
export async function syncSend(
  secret: string,
  peerUrl: string,
  method: "GET" | "POST",
  path: string,
  bodyObj?: unknown,
  timeoutMs = 8000
): Promise<SyncSendResult> {
  if (!secret) return { ok: false };
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${peerUrl}${path}`, {
      method,
      headers: await buildSyncHeaders(secret, method, path, body),
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}
