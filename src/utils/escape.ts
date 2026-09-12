// 出力時のHTMLエスケープ。投稿本文は常にプレーンテキストとして保存し、
// 表示側（フロントエンドのtextContent代入 or ここでのエスケープ後html化）
// の両方でXSS対策を行う。クライアント側だけに依存しない。

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"'/]/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}
