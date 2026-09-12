// Intl.Segmenter (Workers runtime = V8, 対応済み) による書記素クラスタ
// (grapheme cluster) ベースの文字数計測。絵文字のZWJ結合列や結合文字を
// 「見た目の1文字」として正しく1カウントする。

let segmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter {
  if (!segmenter) {
    segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  }
  return segmenter;
}

export function graphemeLength(input: string): number {
  let count = 0;
  for (const _ of getSegmenter().segment(input)) count++;
  return count;
}

// シンプルなURL検出（http/https）。誤検出があっても「投稿を拒否する方向」の
// 安全側に倒すのではなく、あくまで件数上限のカウントに用いる簡易実装。
const URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/gi;

export function countUrls(input: string): number {
  const matches = input.match(URL_REGEX);
  return matches ? matches.length : 0;
}
