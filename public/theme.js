// テーマの事前適用。
// CSP（script-src 'self'）によりインラインスクリプトが使えないため、
// 外部ファイルとして <head> 内で同期的に読み込み、初回描画の前に
// data-theme属性を確定させる（ダーク→ライトのチラつき防止）。
(function () {
  try {
    if (localStorage.getItem("bbs-theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) {
    /* localStorageが利用できない環境では既定（ダーク）のまま */
  }
})();
