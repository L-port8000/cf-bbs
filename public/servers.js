// サーバ一覧ページ（v11新設）。
// 既知の全サーバーを一覧表示し、名前・URLでの検索、お気に入り（★）の
// 追加/解除、「開く」での板への直接アクセスができる。
// お気に入りは端末（ブラウザ）ごとのlocalStorageに保存され、サーバー側には
// 送信しない（common.jsのgetFavoriteServers等を参照）。
// お気に入りが1件でもあるとき、ホームの板では「自分＋お気に入り」だけが
// チップに表示される（無いときは全既知サーバー＝おすすめ表示）。
(async function main() {
  const app = document.getElementById("app");
  const user = await getCurrentUser();
  renderTopbar(app, user, "servers");

  app.appendChild(
    el("div", { class: "back-row" }, [el("a", { class: "btn small secondary", href: "/index.html" }, ["← 板へ戻る"])])
  );

  const card = el("div", { class: "card" }, [
    el("label", {}, ["サーバ一覧"]),
    el("p", { class: "field-hint" }, [
      "知っているcf-bbsサーバーの一覧です。★でお気に入りに登録すると、ホームの板にそのサーバーが表示されるようになります（お気に入りはこの端末・ブラウザごとに保存されます）。別サーバーは読み取り専用で、投稿は各サーバー直接で行います。",
    ]),
  ]);
  app.appendChild(card);

  const searchRow = el("div", { class: "search-row" }, []);
  const listHost = el("div", {}, []);
  card.appendChild(searchRow);
  card.appendChild(listHost);

  showSkeleton(listHost, 3);

  let entries = [];

  try {
    const res = await apiFetch("/api/servers");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ? data.error.message : "一覧の取得に失敗しました");
    entries = [{ ...data.self, self: true }, ...(data.servers || []).map((s) => ({ ...s, self: false }))];
  } catch (err) {
    listHost.innerHTML = "";
    listHost.appendChild(el("div", { class: "banner error" }, [err.message]));
    return;
  }

  const input = el("input", { type: "text", placeholder: "サーバー名・URLで検索", maxlength: "100" }, []);
  const clearBtn = el(
    "button",
    {
      class: "btn small secondary",
      onclick: () => {
        input.value = "";
        render();
      },
    },
    ["クリア"]
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") render();
  });
  // 入力するたびに絞り込む（一覧はAPIから一括取得済みのため純クライアント処理）
  input.addEventListener("input", render);
  searchRow.appendChild(input);
  searchRow.appendChild(clearBtn);

  // 日次ヘルスチェック結果のバッジ（設定ページと同じ仕様。downでも「開く」可能）
  function healthBadge(s) {
    const h = s.self ? "up" : s.health === "up" || s.health === "down" ? s.health : "unknown";
    const dead = !s.self && typeof s.deadDays === "number" && s.deadDays > 0 ? s.deadDays : 0;
    const label = h === "up" ? "稼働中" : h === "down" ? (dead > 0 ? `応答なし(${dead}日)` : "応答なし") : "未確認";
    const span = el("span", { class: `server-health ${h}` }, [label]);
    if (!s.self && typeof s.lastHealthAt === "number") {
      span.title =
        dead > 0
          ? `最終確認: ${formatDate(s.lastHealthAt)} ・ 連続${dead}日到達不能（${dead}日以上続くと自動削除対象）`
          : `最終確認: ${formatDate(s.lastHealthAt)}`;
    }
    return span;
  }

  // ★ボタン（自分のサーバーは常にホームに表示されるため対象外）
  function starButton(s) {
    if (s.self) return null;
    const active = isFavoriteServer(s.url);
    const btn = el(
      "button",
      {
        class: "star-btn" + (active ? " active" : ""),
        title: active ? "お気に入りから削除" : "お気に入りに追加",
        "aria-label": `${s.name}をお気に入り${active ? "から削除" : "に追加"}`,
        onclick: () => {
          toggleFavoriteServer(s.url);
          render();
        },
      },
      [active ? "★" : "☆"]
    );
    return btn;
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const filtered = entries.filter((s) => {
      if (!q) return true;
      return (s.name || "").toLowerCase().includes(q) || (s.url || "").toLowerCase().includes(q);
    });
    // 並び順: 自分 → お気に入り → その他（API返却順）。sortは安定ソート
    const favs = getFavoriteServers();
    const rank = (s) => (s.self ? 0 : favs.indexOf(s.url) >= 0 ? 1 : 2);
    filtered.sort((a, b) => rank(a) - rank(b));

    listHost.innerHTML = "";
    listHost.appendChild(
      el("p", { class: "field-hint", style: "margin-bottom:8px;" }, [
        q ? `「${input.value.trim()}」の検索結果: ${filtered.length}件` : `${filtered.length}台のサーバー`,
      ])
    );
    if (filtered.length === 0) {
      listHost.appendChild(el("div", { class: "empty-state" }, ["該当するサーバーがありません"]));
      return;
    }
    for (const s of filtered) {
      const rowChildren = [
        serverIcon(s.type || "normal"),
        el("div", { class: "grow" }, [
          el("div", { class: "server-name" }, [s.self ? `${s.name}（自分）` : s.name]),
          el("div", { class: "server-url" }, [s.url]),
        ]),
        healthBadge(s),
        starButton(s),
        el(
          "button",
          {
            class: "btn small secondary",
            onclick: () => (window.location.href = s.self ? "/index.html" : `/index.html?server=${encodeURIComponent(s.url)}`),
          },
          ["開く"]
        ),
      ].filter(Boolean);
      listHost.appendChild(el("div", { class: "server-row" }, rowChildren));
    }
  }

  render();
})();
