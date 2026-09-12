import { ApiError } from "../types";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // インラインscriptを使わない設計なので厳格なCSPを既定で適用する。
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  console.error("Unhandled error:", err);
  return jsonResponse(
    { error: { code: "internal_error", message: "内部エラーが発生しました" } },
    { status: 500 }
  );
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  expiresImmediately?: boolean;
  domain?: string;
}

export function buildSessionCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (opts.expiresImmediately) {
    parts.push("Max-Age=0");
  } else if (opts.maxAgeSeconds) {
    parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  }
  // COOKIE_DOMAIN が設定されている場合のみ付与する。Primary/Backupの両ドメインが
  // 同一registrable domainのサブドメインであり、かつ同一Cloudflareアカウント・
  // 同一KV/D1バインディングを共有する構成の場合にのみ有効
  // （詳細はREADME「Primary/Backup API設定」参照）。
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}
