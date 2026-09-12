// Cloudflare Cache API (caches.default) ラッパー。
// 公開閲覧可能な掲示板データ(スレッド一覧・投稿一覧)のみをキャッシュし、
// Session情報・アカウント情報・管理画面等のユーザー固有データは
// 絶対にキャッシュしない（呼び出し側でこの関数を使わないことで担保する）。

export async function getFromCache(request: Request): Promise<Response | undefined> {
  const cache: Cache = caches.default;
  return cache.match(request);
}

export async function putInCache(request: Request, response: Response, ctx: ExecutionContext): Promise<void> {
  const cache: Cache = caches.default;
  ctx.waitUntil(cache.put(request, response));
}

export function withCacheHeaders(body: unknown, maxAgeSec: number, etag: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAgeSec}`,
      ETag: etag,
    },
  });
}
