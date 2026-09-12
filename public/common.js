// cf-bbs 共通フロントエンドユーティリティ。
// XSS対策: ユーザー入力由来の文字列をDOMへ挿入する際は必ず textContent /
// createElement を使い、innerHTML へ生の文字列を渡さない。

function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

let cachedConfig = null;
async function getPublicConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch("/api/public-config");
  cachedConfig = await res.json();
  return cachedConfig;
}

// Primary/Backup フェイルオーバー:
// 同一オリジン(相対パス)への通信が失敗（ネットワークエラー・タイムアウト）した
// 場合のみ、設定されたBackupドメインへ同一リクエストを再試行する。
//
// 【重要な制約】 セッションCookieはHttpOnly + ホスト限定（COOKIE_DOMAIN未設定時）
// のため、Primary/Backupが別ドメインの場合、Backup側へ自動フェイルオーバー
// しても「ログイン済み状態」までは引き継がれない（Backup側で改めてログインが
// 必要）。両ドメインが同一registrable domainのサブドメインで、かつ
// wrangler.tomlのCOOKIE_DOMAINを設定している構成に限り、Cookieが共有され
// シームレスなフェイルオーバーが可能になる。詳細はREADMEを参照。
async function apiFetch(path, options = {}) {
  const config = await getPublicConfig();
  const opts = Object.assign({ credentials: "include" }, options);
  opts.headers = Object.assign({}, options.headers);

  const csrf = getCookie("bbs_csrf");
  const method = (opts.method || "GET").toUpperCase();
  if (csrf && method !== "GET" && method !== "HEAD") {
    opts.headers["X-CSRF-Token"] = csrf;
  }

  try {
    return await fetch(path, opts);
  } catch (networkErr) {
    if (!config.backupDomain || config.deploymentRole !== "primary") throw networkErr;
    const backupUrl = `https://${config.backupDomain}${path}`;
    try {
      return await fetch(backupUrl, opts);
    } catch (err2) {
      throw networkErr;
    }
  }
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

let turnstileLoadPromise = null;
function loadTurnstile() {
  if (turnstileLoadPromise) return turnstileLoadPromise;
  turnstileLoadPromise = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error("Turnstileの読み込みに失敗しました"));
    document.head.appendChild(script);
  });
  return turnstileLoadPromise;
}

async function renderTurnstile(containerOrId) {
  const config = await getPublicConfig();
  const turnstile = await loadTurnstile();
  // ID文字列でも要素そのものでも受け付ける（動的生成フォームは要素を直接渡す）
  const container = typeof containerOrId === "string" ? document.getElementById(containerOrId) : containerOrId;
  if (!container) throw new Error("Turnstileの描画先が見つかりません");
  container.innerHTML = "";
  let currentToken = null;
  const widgetId = turnstile.render(container, {
    sitekey: config.turnstileSiteKey,
    // サイトのテーマ（白/暗黒モード）に合わせる
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    // トークンには約5分の有効期限がある。期限切れ時は自動で再発行させる
    "refresh-expired": "auto",
    callback: (token) => {
      currentToken = token;
    },
    "expired-callback": () => {
      currentToken = null;
    },
    "error-callback": () => {
      currentToken = null;
    },
  });
  return {
    getToken: () => currentToken,
    // Turnstileのトークンは1回の検証で消費される。送信が失敗した後に同じ
    // トークンを再送すると「使用済み（timeout-or-duplicate）」扱いで必ず
    // 失敗するため、リトライ前に必ずreset()して新しいトークンを取り直す。
    reset: () => {
      currentToken = null;
      try {
        turnstile.reset(widgetId);
      } catch {
        /* ウィジェット未初期化等では無視 */
      }
    },
  };
}

async function requireLogin(redirectTo) {
  const res = await apiFetch("/api/auth/me");
  const data = await res.json();
  if (!data.user) {
    window.location.href = "/login.html" + (redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : "");
    return null;
  }
  return data.user;
}

async function getCurrentUser() {
  const res = await apiFetch("/api/auth/me");
  const data = await res.json();
  return data.user;
}

function renderTopbar(container, user, activePage) {
  const links = el("div", { class: "nav-links" }, [
    el("a", { href: "/index.html" }, ["板"]),
    user ? el("a", { href: "/settings.html" }, ["設定"]) : null,
    // 利用状況は管理者に限らずログイン済みの全ユーザーが見られる（要望仕様）
    user ? el("a", { href: "/status.html" }, ["利用状況"]) : null,
    user && user.role === "admin" ? el("a", { href: "/admin.html" }, ["管理"]) : null,
    // ログアウトは設定ページの下部へ移動したため、ここにはユーザー名を表示する。
    // （未ログイン時は従来どおりログインへのリンク）
    user
      ? el("a", { href: "/settings.html", class: "topbar-user", title: "設定を開く" }, [user.username || "名無しさん"])
      : el("a", { href: "/login.html" }, ["ログイン"]),
  ]);
  // 見出し「cf-bbs」をトップページへのリンクにする（要望仕様）。
  // 相対リンクを既定にしつつ、設定が読めてから自サーバーの絶対URL
  // （PRIMARY_API_DOMAIN）へ差し替える。フォールバックでも動作を壊さない。
  const brandLink = el("a", { href: "/index.html", class: "brand-link" }, ["cf-bbs"]);
  getPublicConfig()
    .then((config) => {
      if (config && config.primaryDomain) brandLink.setAttribute("href", `https://${config.primaryDomain}/`);
    })
    .catch(() => {});
  container.appendChild(el("div", { class: "topbar" }, [el("h1", {}, [brandLink]), links]));
  void activePage;
}

async function onLogoutClick() {
  await apiFetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/index.html";
}

// ---------------------------------------------------------------------------
// テーマ（ダーク/ホワイトモード）切替。
// 選択はlocalStorageに保存し、各HTMLの<head>内インラインスクリプトが
// 描画前にdata-theme属性へ反映する（チラつき防止）。
// ---------------------------------------------------------------------------
function getStoredTheme() {
  try {
    const t = localStorage.getItem("bbs-theme");
    return t === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try {
    localStorage.setItem("bbs-theme", theme);
  } catch {
    /* localStorageが使えない環境ではセッション限りの切替になる */
  }
}

// ---------------------------------------------------------------------------
// サーバー種別アイコン。通常サーバー（アカウント必須）はサーバーラック風、
// 将来の匿名サーバーは鍵無しの自由な形を表す別アイコンを表示する。
// SVGは固定文字列のみで構成し、ユーザー入力は一切含まない。
// ---------------------------------------------------------------------------
function serverIcon(type) {
  const span = document.createElement("span");
  span.className = "server-icon" + (type === "anonymous" ? " anonymous" : "");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML =
    type === "anonymous"
      ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v2h1a2 2 0 0 1 2 2v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v2h6V7a3 3 0 0 0-3-3Z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1.5 2a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm1.5 2a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/></svg>';
  return span;
}

function showBanner(container, type, message) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: `banner ${type}` }, [message]));
}

// ボタンを「処理中」表示に切り替える/元に戻すヘルパー。
// 投稿・ログイン・登録など、レスポンスに数百ms〜数秒かかり得る操作で
// 「反応が無い」と誤解されないよう、必ずこれを使ってフィードバックを出す。
function setButtonLoading(btn, loadingText) {
  if (btn.dataset.originalText === undefined) {
    btn.dataset.originalText = btn.textContent;
  }
  btn.disabled = true;
  btn.innerHTML = "";
  btn.appendChild(el("span", { class: "spinner" }, []));
  btn.appendChild(document.createTextNode(loadingText || "処理中..."));
}

function clearButtonLoading(btn) {
  btn.disabled = false;
  if (btn.dataset.originalText !== undefined) {
    btn.textContent = btn.dataset.originalText;
  }
}

function showSkeleton(container, count) {
  container.innerHTML = "";
  for (let i = 0; i < (count || 3); i++) {
    container.appendChild(el("div", { class: "skeleton" }));
  }
}

// リモートサーバー（複数サーバー選択機能で選ばれた他サーバー）から
// 認証情報無しで公開データだけを読み取るための素のfetchラッパー。
// Cookie等は一切送らない（送っても相手には無視されるが、意図を明確にするため
// credentials: "omit" を明示する）。
async function fetchRemote(serverUrl, path) {
  return fetch(`${serverUrl}${path}`, { credentials: "omit" });
}

// ---------------------------------------------------------------------------
// サーバーお気に入り（ブックマーク）。
// 「お気に入りに登録した他サーバーのURL」をlocalStorageに保存する。
// 端末（ブラウザ）ごとの設定であり、サーバー側へは送信・保存しない。
// お気に入りが1件でもあるとき、ホームのサーバー切替は「自分＋お気に入り」
// のみを表示する（1件も無いときは従来どおり全既知サーバー＝おすすめ表示）。
// 削除済みサーバー等のURLが残っていても、表示側で既知サーバーとの照合に
// 使うため害は出ない（getFavoriteServersはURL文字列の配列をそのまま返す）。
// ---------------------------------------------------------------------------
const FAVORITE_SERVERS_KEY = "bbs-favorite-servers";

function getFavoriteServers() {
  try {
    const raw = localStorage.getItem(FAVORITE_SERVERS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // 文字列以外（壊れたデータ）は除外して返す
    return arr.filter((u) => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

function isFavoriteServer(url) {
  return getFavoriteServers().indexOf(url) >= 0;
}

// お気に入りをトグルする。戻り値は true=追加 / false=削除。
function toggleFavoriteServer(url) {
  const cur = getFavoriteServers();
  const i = cur.indexOf(url);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(url);
  try {
    localStorage.setItem(FAVORITE_SERVERS_KEY, JSON.stringify(cur));
  } catch {
    /* localStorageが使えない環境ではセッション限り（保存せず続行） */
  }
  return i < 0;
}

// メールアドレス・パスワードなど「半角のみ」を許可したい入力欄のためのガード。
// 全角・日本語・絵文字等は入力（貼り付け含む）した瞬間に自動で除去する
// （サーバー側でも登録時に同じ基準で検証する：src/routes/auth.ts参照）。
function restrictHalfWidth(input) {
  if (!input) return;
  input.addEventListener("input", () => {
    const cleaned = input.value.replace(/[^\x20-\x7E]/g, "");
    if (cleaned !== input.value) {
      const pos = input.selectionStart;
      input.value = cleaned;
      try {
        input.setSelectionRange(pos, pos);
      } catch {
        /* type=password等でselectionが扱えない環境では無視 */
      }
    }
  });
}
