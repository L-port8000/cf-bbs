(async function main() {
  const app = document.getElementById("app");
  const params = new URLSearchParams(window.location.search);
  const threadId = Number(params.get("id"));
  const serverUrl = params.get("server") ? decodeURIComponent(params.get("server")) : null;
  const serverName = params.get("name") ? decodeURIComponent(params.get("name")) : serverUrl;
  const server = serverUrl ? { url: serverUrl, name: serverName } : null;

  if (!threadId || Number.isNaN(threadId)) {
    app.appendChild(el("div", { class: "banner error" }, ["不正なスレッドIDです"]));
    return;
  }

  const user = server ? null : await getCurrentUser();
  renderTopbar(app, user, "thread");

  // スレッド一覧へ戻るボタン。他サーバー閲覧時はそのサーバーを選択した
  // 状態のまま一覧へ戻れる（要望仕様: スレッド一覧に戻るボタン）。
  // 並べて「一番下へ」ボタンも配置する（押したときに初めて最下部へ移動。
  // 自動スクロールはしない・要望仕様）。
  const backHref = server ? `/index.html?server=${encodeURIComponent(server.url)}` : "/index.html";
  app.appendChild(
    el("div", { class: "back-row" }, [
      el("a", { class: "btn secondary small", href: backHref }, ["← スレッド一覧に戻る"]),
      el(
        "button",
        {
          class: "btn secondary small",
          onclick: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }),
        },
        ["一番下へ ↓"]
      ),
    ])
  );

  const bannerHost = el("div", {});
  app.appendChild(bannerHost);

  if (server) {
    bannerHost.appendChild(
      el("div", { class: "banner info" }, [
        `「${server.name}」の投稿を閲覧しています（読み取り専用）。投稿するには`,
        el("a", { href: `${server.url}/thread.html?id=${threadId}`, target: "_blank", rel: "noopener" }, ["こちらから直接アクセス"]),
        "してください。",
      ])
    );
  }

  const body = el("div", { id: "thread-body" }, []);
  app.appendChild(body);
  showSkeleton(body, 3);

  await loadThread(body, bannerHost, threadId, user, server);
})();

async function loadThread(host, bannerHost, threadId, user, server) {
  try {
    const res = server
      ? await fetchRemote(server.url, `/api/threads/${threadId}/posts?limit=100`)
      : await apiFetch(`/api/threads/${threadId}/posts?limit=100`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ? data.error.message : "取得に失敗しました");

    host.innerHTML = "";
    host.appendChild(el("h2", {}, [data.thread.title]));

    const posts = [...data.posts].reverse();
    // レス番号はサーバー側の投稿ID（#24など）ではなく、クライアント側で
    // 「読み込まれたレス」の先頭から1,2,3...と採番して表示する。
    // スレッド主のメタ行にも、読み込めたレス総数を併記する。
    const state = { replyCount: posts.length, threadOwner: data.thread.username || "名無しさん" };
    const metaDiv = el("div", { class: "thread-meta", style: "margin: -8px 0 12px;" }, [
      `スレ主: ${state.threadOwner} ・ レス ${state.replyCount}件`,
    ]);
    host.appendChild(metaDiv);

    const listHost = el("div", {}, []);
    let replyNo = 0;
    for (const p of posts) {
      replyNo += 1;
      listHost.appendChild(renderPost(p, replyNo, threadId, user, server, bannerHost, () => loadThread(host, bannerHost, threadId, user, server)));
    }
    host.appendChild(listHost);

    // 返信が成功したら、D1へ再取得しに行かず投稿した内容をその場で一覧末尾へ
    // 追記する（D1の読み取り回数削減のため。要望仕様）。レス数カウンタも
    // クライアント側だけで更新する。
    function appendLocalPost(localPost) {
      state.replyCount += 1;
      const node = renderPost(localPost, state.replyCount, threadId, user, server, bannerHost, () => loadThread(host, bannerHost, threadId, user, server));
      listHost.appendChild(node);
      metaDiv.textContent = `スレ主: ${state.threadOwner} ・ レス ${state.replyCount}件`;
      node.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    if (server) {
      // リモートサーバーの内容は読み取り専用（返信・モデレーションUIは出さない）
    } else if (user) {
      host.appendChild(buildReplyForm(threadId, user.username || "名無しさん", bannerHost, appendLocalPost));
    } else {
      host.appendChild(
        el("div", { class: "card" }, [el("a", { href: "/login.html" }, ["ログイン"]), el("span", {}, [" すると返信できます"])])
      );
    }

    if (!server && user && user.role === "admin") {
      host.appendChild(buildThreadModerationBar(threadId, bannerHost, () => loadThread(host, bannerHost, threadId, user, server)));
    }
  } catch (err) {
    host.innerHTML = "";
    host.appendChild(el("div", { class: "banner error" }, [err.message]));
  }
}

function renderPost(p, replyNo, threadId, user, server, bannerHost, onChanged) {
  const isHidden = p.status === "hidden";
  const actions = [];
  if (!server && user && user.role === "admin") {
    actions.push(
      el(
        "button",
        {
          class: "btn ghost small",
          onclick: async (e) => {
            await moderate(`/api/admin/threads/${threadId}/posts/${p.post_id}/${isHidden ? "unhide" : "hide"}`, e.target, bannerHost, onChanged);
          },
        },
        [isHidden ? "表示に戻す" : "非表示"]
      )
    );
    actions.push(
      el(
        "button",
        {
          class: "btn ghost small",
          onclick: async (e) => {
            if (!confirm("この投稿を削除しますか？")) return;
            await moderate(`/api/admin/threads/${threadId}/posts/${p.post_id}/delete`, e.target, bannerHost, onChanged);
          },
        },
        ["削除"]
      )
    );
  }

  return el("div", { class: "post-item" + (isHidden ? " hidden-post" : "") }, [
    el("div", { class: "post-meta" }, [
      el("span", {}, [`${replyNo} ${p.username || "名無しさん"} ・ ${formatDate(p.created_at)}`]),
      actions.length ? el("span", {}, actions) : null,
    ]),
    el("div", { class: "post-body" }, [isHidden ? "（管理者により非表示にされました）" : p.body]),
  ]);
}

async function moderate(path, triggerBtn, bannerHost, onChanged) {
  const originalText = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) setButtonLoading(triggerBtn, "処理中...");
  try {
    const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error ? data.error.message : "操作に失敗しました");
    }
    await onChanged();
  } catch (err) {
    showBanner(bannerHost, "error", err.message);
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = originalText;
    }
  }
}

function buildThreadModerationBar(threadId, bannerHost, onChanged) {
  return el("div", { class: "card" }, [
    el("label", {}, ["管理者操作"]),
    el("div", { class: "form-actions" }, [
      el(
        "button",
        {
          class: "btn secondary small",
          onclick: (e) => moderate(`/api/admin/threads/${threadId}/hide`, e.target, bannerHost, onChanged),
        },
        ["スレッドを非表示"]
      ),
      el(
        "button",
        {
          class: "btn danger small",
          onclick: (e) => {
            // 「削除」はレス全件ごとの完全削除（実DELETE）とする（要望仕様）。
            if (confirm("このスレッドをレス全件ごと完全に削除します。元に戻せません。よろしいですか？")) {
              moderate(`/api/admin/threads/${threadId}/purge`, e.target, bannerHost, onChanged);
            }
          },
        },
        ["スレッドを完全削除"]
      ),
    ]),
  ]);
}

function buildReplyForm(threadId, displayName, bannerHost, onPostedLocal) {
  let turnstileHandle = null;
  let turnstileOnPost = false;
  const bodyInput = el("textarea", { placeholder: "返信を入力" }, []);
  const counter = el("div", { class: "char-counter" }, ["0 文字"]);
  const turnstileContainer = el("div", { id: "reply-turnstile" }, []);
  const submitBtn = el("button", { class: "btn", type: "button", onclick: onSubmit }, ["返信する"]);

  bodyInput.addEventListener("input", () => {
    const len = [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(bodyInput.value)].length;
    counter.textContent = `${len} 文字`;
    counter.className = "char-counter" + (len > 200 ? " over" : len > 160 ? " warn" : "");
  });

  // 管理設定で投稿時Turnstileが有効かどうか（トークン未取得送信の事前チェック用）
  getPublicConfig()
    .then((c) => {
      turnstileOnPost = !!(c && c.turnstileOnPost);
    })
    .catch(() => {});

  // フォームがDOMへ接続された後にウィジェットを描画する。
  // この関数は戻り値の要素がまだ接続されていない段階で呼ばれるため、
  // getElementByIdベースの描画をこのタイミングで行うと失敗する
  // （従来はここが原因でスレッド画面の返信フォームにウィジェットが出ていなかった）。
  // 要素を直接渡し、setTimeoutで接続後へ確実に回す。
  setTimeout(() => {
    renderTurnstile(turnstileContainer)
      .then((h) => (turnstileHandle = h))
      .catch(() => {});
  }, 0);

  async function onSubmit() {
    bannerHost.innerHTML = "";
    // 投稿時Turnstileが有効なのにトークンがまだ無い場合は、送信しても
    // サーバー側で必ず失敗するためここで案内して中断する
    if (turnstileOnPost && (!turnstileHandle || !turnstileHandle.getToken())) {
      if (turnstileHandle) turnstileHandle.reset();
      showBanner(bannerHost, "error", "Turnstileの認証準備ができていません。少し待ってからもう一度お試しください");
      return;
    }

    setButtonLoading(submitBtn, "投稿中...");
    try {
      const res = await apiFetch(`/api/threads/${threadId}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: bodyInput.value, turnstileToken: turnstileHandle ? turnstileHandle.getToken() : null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "投稿に失敗しました");

      const postedBody = bodyInput.value;
      bodyInput.value = "";
      counter.textContent = "0 文字";
      counter.className = "char-counter";

      // D1には再確認しに行かない。投稿APIの応答（post_id）と手元の内容で
      // そのまま画面へ反映する（表示名・日時はクライアント側の値を使用）。
      onPostedLocal({
        post_id: data.post_id,
        username: displayName,
        body: postedBody,
        created_at: Date.now(),
        status: "visible",
      });
      // 成功時もトークンは消費されている。次の投稿用に新しいトークンを取得させる
      if (turnstileHandle) turnstileHandle.reset();
      clearButtonLoading(submitBtn);
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      // 失敗したリクエストでトークンは消費済み。新しいトークンを取り直させる
      if (turnstileHandle) turnstileHandle.reset();
      clearButtonLoading(submitBtn);
    }
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["返信"]),
    bodyInput,
    counter,
    turnstileContainer,
    el("div", { class: "form-actions" }, [submitBtn]),
  ]);
}
