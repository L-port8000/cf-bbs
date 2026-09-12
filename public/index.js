(async function main() {
  const app = document.getElementById("app");
  const user = await getCurrentUser();
  renderTopbar(app, user, "index");

  const bannerHost = el("div", {});
  app.appendChild(bannerHost);

  const switcherHost = el("div", { class: "server-switcher" }, []);
  app.appendChild(switcherHost);

  const formHost = el("div", {}, []);
  app.appendChild(formHost);

  // スレッド名検索（v10新設）。サーバー切替時に検索語はリセットする
  const searchHost = el("div", { class: "search-row" }, []);
  app.appendChild(searchHost);

  const listHost = el("div", { id: "thread-list" }, []);
  app.appendChild(listHost);

  showSkeleton(listHost, 3);

  let servers = [{ url: "", name: "このサーバー", self: true }];
  let current = servers[0];

  // 設定ページのサーバ一覧から「開く」で来た場合（?server=<url>）、
  // そのサーバーを選択した状態で表示する。
  const params = new URLSearchParams(window.location.search);
  const requestedServer = params.get("server");

  try {
    const res = await fetch("/api/servers");
    const data = await res.json();
    servers = [{ ...data.self, self: true }, ...(data.servers || []).map((s) => ({ ...s, self: false }))];
    current = servers[0];
    if (requestedServer) {
      const found = servers.find((s) => !s.self && s.url === requestedServer);
      if (found) current = found;
    }
  } catch {
    // サーバー一覧が取れなくても、自分のサーバーの板は表示を続ける
  }

  renderSwitcher();
  renderSearchBox();
  await showServer(current);

  function renderSearchBox() {
    searchHost.innerHTML = "";
    const input = el("input", { type: "text", placeholder: "スレッド名で検索", maxlength: "100" }, []);
    const btn = el("button", { class: "btn small", onclick: doSearch }, ["検索"]);
    const clearBtn = el(
      "button",
      {
        class: "btn small secondary",
        onclick: () => {
          input.value = "";
          btn.textContent = "検索";
          loadThreads(listHost, current, null);
        },
      },
      ["クリア"]
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

    async function doSearch() {
      const q = input.value.trim();
      btn.textContent = "検索";
      await loadThreads(listHost, current, q || null);
    }

    searchHost.appendChild(input);
    searchHost.appendChild(btn);
    searchHost.appendChild(clearBtn);
  }

  // サーバー切替チップ列。
  // お気に入り（★・端末ごとのlocalStorage保存）が1件でもあるときは
  // 「自分＋お気に入りサーバー」だけを表示し、1件も無いときは従来どおり
  // 全既知サーバーをおすすめとして表示する（v11新設）。
  // 末尾の「サーバ一覧へ」から全サーバーの一覧ページ（検索可）へ移動できる。
  function renderSwitcher() {
    switcherHost.innerHTML = "";
    if (servers.length <= 1) return; // 他に既知サーバーが無ければ切り替えUI自体を出さない

    const favoriteServers = getFavoriteServers()
      .map((u) => servers.find((s) => !s.self && s.url === u))
      .filter(Boolean);
    const hasFav = favoriteServers.length > 0;
    const targets = hasFav ? favoriteServers.slice() : servers.filter((s) => !s.self);
    // ?server=指定などでお気に入り外のサーバーを表示中の場合は、
    // 現在見ているサーバーのチップも並べる（選択状態が分からなくなるのを防ぐ）
    if (hasFav && current && !current.self && !targets.includes(current)) targets.push(current);

    switcherHost.appendChild(
      el("div", { class: "switcher-label" }, [hasFav ? "★ お気に入りサーバー" : "おすすめサーバー"])
    );

    const chipRow = el("div", { class: "server-chip-row" }, []);
    chipRow.appendChild(
      el(
        "button",
        {
          class: "server-chip" + (servers[0].url === current.url ? " active" : ""),
          onclick: () => {
            current = servers[0];
            renderSwitcher();
            showServer(servers[0]);
          },
        },
        [`${servers[0].name}（自分）`]
      )
    );
    for (const s of targets) {
      chipRow.appendChild(
        el(
          "button",
          {
            class: "server-chip" + (s.url === current.url ? " active" : ""),
            onclick: () => {
              current = s;
              renderSwitcher();
              showServer(s);
            },
          },
          [s.name]
        )
      );
    }
    chipRow.appendChild(el("a", { class: "server-chip server-list-link", href: "/servers.html" }, ["サーバ一覧へ →"]));
    switcherHost.appendChild(chipRow);
  }

  async function showServer(server) {
    bannerHost.innerHTML = "";
    formHost.innerHTML = "";
    showSkeleton(listHost, 3);

    if (server.self) {
      if (user) {
        formHost.appendChild(buildNewThreadForm(bannerHost, () => showServer(server)));
      } else {
        formHost.appendChild(
          el("div", { class: "card" }, [
            el("p", {}, ["投稿するには"]),
            el("a", { href: "/login.html" }, ["ログイン"]),
            el("span", {}, [" または "]),
            el("a", { href: "/register.html" }, ["新規登録"]),
            el("span", {}, [" してください。"]),
          ])
        );
      }
      await loadThreads(listHost, null, null);
    } else {
      formHost.appendChild(
        el("div", { class: "banner info" }, [
          `「${server.name}」は別サーバーです。ここでは閲覧のみできます。投稿するには`,
          el("a", { href: server.url, target: "_blank", rel: "noopener" }, ["こちらから直接アクセス"]),
          "してください。",
        ])
      );
      await loadThreads(listHost, server, null);
    }
  }

  async function loadThreads(host, server, query) {
    try {
      const qParam = query ? `&q=${encodeURIComponent(query)}` : "";
      const res = server
        ? await fetchRemote(server.url, `/api/threads?limit=30${qParam}`)
        : await apiFetch(`/api/threads?limit=30${qParam}`);
      const data = await res.json();
      host.innerHTML = "";
      if (query) {
        host.appendChild(
          el("div", { class: "field-hint", style: "margin-bottom:8px;" }, [`「${query}」の検索結果: ${data.threads ? data.threads.length : 0}件`])
        );
      }
      if (!data.threads || data.threads.length === 0) {
        host.appendChild(
          el("div", { class: "empty-state" }, [query ? "該当するスレッドが見つかりません" : "まだスレッドがありません。最初の投稿をしてみましょう。"])
        );
        return;
      }
      for (const t of data.threads) {
        const href = server ? `/thread.html?id=${t.thread_id}&server=${encodeURIComponent(server.url)}&name=${encodeURIComponent(server.name)}` : `/thread.html?id=${t.thread_id}`;
        host.appendChild(
          el("a", { class: "thread-item", href }, [
            el("div", { class: "thread-title" }, [t.title]),
            el("div", { class: "thread-meta" }, [`${t.username || "名無しさん"} ・ 最終更新: ${formatDate(t.last_activity_at)}`]),
          ])
        );
      }
    } catch (err) {
      host.innerHTML = "";
      host.appendChild(el("div", { class: "banner error" }, ["スレッド一覧の取得に失敗しました"]));
    }
  }
})();

function buildNewThreadForm(bannerHost, onPosted) {
  let turnstileHandle = null;
  let turnstileOnPost = false;

  const titleInput = el("input", { type: "text", placeholder: "スレッドタイトル", maxlength: "100" }, []);
  const bodyInput = el("textarea", { placeholder: "本文（最初の投稿）", maxlength: "800" }, []);
  const counter = el("div", { class: "char-counter" }, ["0 文字"]);
  const turnstileContainer = el("div", { id: "new-thread-turnstile" }, []);
  const submitBtn = el("button", { class: "btn", type: "button", onclick: onSubmit }, ["スレッドを作成"]);

  bodyInput.addEventListener("input", () => {
    const len = [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(bodyInput.value)].length;
    counter.textContent = `${len} 文字`;
    counter.className = "char-counter" + (len > 200 ? " over" : len > 160 ? " warn" : "");
  });

  getPublicConfig().then(async (config) => {
    // 管理設定で投稿時Turnstileが有効かどうか（トークン未取得送信の事前チェック用）
    turnstileOnPost = !!(config && config.turnstileOnPost);
    // Turnstileは管理設定次第で投稿時にも要求されるため常に描画しておく
    // （不要な場合はサーバー側で無視される）。この時点でフォームはDOMへ
    // 接続済みなので、getElementByIdでも要素を直接渡しても描画できる。
    try {
      turnstileHandle = await renderTurnstile(turnstileContainer);
    } catch {
      /* ウィジェット描画失敗時はトークン無しで送信（サーバー設定次第で拒否される） */
    }
  });

  async function onSubmit() {
    bannerHost.innerHTML = "";
    // 投稿時Turnstileが有効なのにトークンがまだ無い場合は、送信しても
    // サーバー側で必ず失敗するためここで案内して中断する
    if (turnstileOnPost && (!turnstileHandle || !turnstileHandle.getToken())) {
      if (turnstileHandle) turnstileHandle.reset();
      showBanner(bannerHost, "error", "Turnstileの認証準備ができていません。少し待ってからもう一度お試しください");
      return;
    }

    setButtonLoading(submitBtn, "作成中...");
    try {
      const res = await apiFetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleInput.value,
          body: bodyInput.value,
          turnstileToken: turnstileHandle ? turnstileHandle.getToken() : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "作成に失敗しました");
      window.location.href = `/thread.html?id=${data.thread_id}`;
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      // 失敗したリクエストでトークンは消費済み。新しいトークンを取り直させる
      if (turnstileHandle) turnstileHandle.reset();
      clearButtonLoading(submitBtn);
      void onPosted;
    }
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["新しいスレッド"]),
    titleInput,
    el("label", {}, ["本文"]),
    bodyInput,
    counter,
    turnstileContainer,
    el("div", { class: "form-actions" }, [submitBtn]),
  ]);
}
