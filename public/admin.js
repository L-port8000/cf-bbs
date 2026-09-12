(async function main() {
  const app = document.getElementById("app");
  const user = await requireLogin("/admin.html");
  if (!user) return;
  if (user.role !== "admin") {
    app.appendChild(el("div", { class: "banner error" }, ["管理者権限が必要です"]));
    return;
  }

  renderTopbar(app, user, "admin");
  app.appendChild(el("h2", {}, ["管理画面"]));

  const bannerHost = el("div", {});
  app.appendChild(bannerHost);

  const tabs = ["概要", "ユーザー", "スレッド", "設定", "シャード移行", "サーバー管理", "監査ログ"];
  const tabButtons = {};
  const tabBar = el(
    "div",
    { class: "tabs" },
    tabs.map((t) =>
      el(
        "button",
        {
          onclick: () => switchTab(t),
        },
        [t]
      )
    )
  );
  tabBar.querySelectorAll("button").forEach((btn, i) => (tabButtons[tabs[i]] = btn));
  app.appendChild(tabBar);

  const panelHost = el("div", {}, []);
  app.appendChild(panelHost);

  function switchTab(name) {
    Object.values(tabButtons).forEach((b) => b.classList.remove("active"));
    tabButtons[name].classList.add("active");
    panelHost.innerHTML = "";
    if (name === "概要") panelHost.appendChild(buildOverviewPanel(bannerHost, switchTab));
    if (name === "ユーザー") panelHost.appendChild(buildUsersPanel(bannerHost));
    if (name === "スレッド") panelHost.appendChild(buildThreadsPanel(bannerHost));
    if (name === "設定") panelHost.appendChild(buildSettingsPanel(bannerHost));
    if (name === "シャード移行") panelHost.appendChild(buildShardPanel(bannerHost));
    if (name === "サーバー管理") panelHost.appendChild(buildServersPanel(bannerHost));
    if (name === "監査ログ") panelHost.appendChild(buildAuditPanel(bannerHost));
  }

  switchTab("概要");
})();

function buildOverviewPanel(bannerHost, switchTab) {
  const host = el("div", {}, []);
  showSkeleton(host, 3);

  apiFetch("/api/admin/overview")
    .then((res) => res.json())
    .then((data) => {
      host.innerHTML = "";
      host.appendChild(
        el("div", { class: "card" }, [
          el("p", { class: "field-hint" }, ["このBBSの現在の状態をひと目で確認できます。詳しい操作は各タブから行ってください。"]),
        ])
      );

      const statGrid = el("div", { style: "display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px;" }, [
        statCard("登録ユーザー数", data.users.total, () => switchTab("ユーザー")),
        statCard("うちBAN中", data.users.banned, () => switchTab("ユーザー")),
        statCard("管理者数", data.users.admins, () => switchTab("ユーザー")),
        statCard("公開スレッド数", data.threads, () => switchTab("シャード移行")),
        statCard("既知サーバー数", data.knownServers, () => switchTab("サーバー管理")),
        statCard("過去24hの管理操作", data.auditActionsLast24h, () => switchTab("監査ログ")),
      ]);
      host.appendChild(statGrid);

      host.appendChild(
        el("div", { class: "card" }, [
          el("label", {}, ["現在の主な設定"]),
          el("p", {}, [`登録・ログイン時のTurnstile: ${data.turnstileOnAuth ? "有効" : "無効"}`]),
          el("p", {}, [`投稿時のTurnstile: ${data.turnstileOnPost ? "有効" : "無効"}`]),
          el("p", {}, [`データ保持期間: ${data.dataRetentionDays}日`]),
          el("div", { class: "form-actions" }, [
            el("button", { class: "btn secondary small", onclick: () => switchTab("設定") }, ["設定を変更する"]),
          ]),
        ])
      );
    })
    .catch((err) => {
      host.innerHTML = "";
      showBanner(bannerHost, "error", err.message);
    });

  return host;
}

function statCard(label, value, onClick) {
  return el(
    "button",
    {
      class: "card",
      style: "text-align:left; cursor:pointer; border:none; width:100%; display:block;",
      onclick: onClick,
    },
    [
      el("div", { style: "font-size:22px; font-weight:700;" }, [String(value)]),
      el("div", { class: "field-hint" }, [label]),
    ]
  );
}

function buildUsersPanel(bannerHost) {
  const container = el("div", {}, []);
  container.appendChild(
    el("p", { class: "field-hint" }, ["サーバー内のアカウント一覧（新しい順・最大50件）。メールアドレスの一部やuser_idで絞り込みもできます。"])
  );
  const searchInput = el("input", { type: "text", placeholder: "メールアドレスまたはuser_idで検索（空欄で全件）" }, []);
  const searchBtn = el("button", { class: "btn small", onclick: doSearch }, ["検索・更新"]);
  const resultsHost = el("div", {}, []);

  container.appendChild(el("div", { class: "form-actions" }, [searchInput, searchBtn]));
  container.appendChild(resultsHost);

  async function doSearch() {
    setButtonLoading(searchBtn, "検索中...");
    showSkeleton(resultsHost, 3);
    try {
      const res = await apiFetch(`/api/admin/users?q=${encodeURIComponent(searchInput.value)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "検索に失敗しました");
      renderUsers(data.users);
    } catch (err) {
      resultsHost.innerHTML = "";
      showBanner(bannerHost, "error", err.message);
    } finally {
      clearButtonLoading(searchBtn);
    }
  }

  function renderUsers(users) {
    resultsHost.innerHTML = "";
    if (users.length === 0) {
      resultsHost.appendChild(el("div", { class: "empty-state" }, ["該当するユーザーがいません"]));
      return;
    }
    const table = el("table", { class: "admin-table" }, [
      el("thead", {}, [el("tr", {}, [el("th", {}, ["メール"]), el("th", {}, ["ユーザー名"]), el("th", {}, ["状態"]), el("th", {}, ["操作"])])]),
    ]);
    const tbody = el("tbody", {}, []);
    for (const u of users) {
      const tags = [el("span", { class: `tag ${u.tier}` }, [u.tier])];
      if (u.role === "admin") tags.push(el("span", { class: "tag admin" }, ["admin"]));
      if (u.status === "banned") {
        tags.push(el("span", { class: "tag banned" }, ["banned"]));
        if (u.ban_reason) tags.push(el("span", { class: "field-hint" }, [u.ban_reason]));
      }

      const actions = [];
      if (u.role !== "admin") {
        if (u.status === "banned") {
          actions.push(
            el(
              "button",
              { class: "btn secondary small", onclick: (e) => act(`/api/admin/users/${u.user_id}/unban`, "POST", {}, e.target) },
              ["BAN解除"]
            )
          );
        } else {
          actions.push(
            el(
              "button",
              {
                class: "btn danger small",
                onclick: (e) => {
                  const reason = prompt("BAN理由を入力してください", "規約違反");
                  if (reason !== null) act(`/api/admin/users/${u.user_id}/ban`, "POST", { reason }, e.target);
                },
              },
              ["BAN"]
            )
          );
        }
        actions.push(
          el(
            "button",
            { class: "btn ghost small", onclick: (e) => act(`/api/admin/users/${u.user_id}/role`, "POST", { role: "admin" }, e.target) },
            ["管理者に昇格"]
          )
        );
      }
      // 管理者によるパスワード再設定（v10新設）。
      // 空欄で確定すると仮パスワードを自動生成して1回だけ表示する。
      actions.push(
        el(
          "button",
          {
            class: "btn secondary small",
            onclick: async (e) => {
              const pw = prompt(
                `${u.email} の新しいパスワードを入力してください（半角8〜20文字）。\n空欄のままOKを押すと仮パスワードを自動生成します。`,
                ""
              );
              if (pw === null) return;
              if (pw.trim().length > 0 && (pw.trim().length < 8 || !/^[\x20-\x7E]+$/.test(pw.trim()))) {
                alert("パスワードは半角8文字以上にしてください（全角不可）");
                return;
              }
              setButtonLoading(e.target, "処理中...");
              try {
                const res = await apiFetch(`/api/admin/users/${u.user_id}/reset-password`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: pw.trim() }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ? data.error.message : "再設定に失敗しました");
                if (data.generated && data.generatedPassword) {
                  alert(
                    `仮パスワード: ${data.generatedPassword}\n\nこの表示は一度きりです。ユーザーへ安全に伝えてください（サーバー側には保存されません）。\n※対象ユーザーは全端末でログアウトされるため、この仮パスワードでの再ログインが必要です`
                  );
                } else {
                  alert("パスワードを再設定しました。該当ユーザーの全セッション（全端末）をログアウトしました。対象ユーザーは新しいパスワードで再ログインしてください");
                }
              } catch (err) {
                showBanner(bannerHost, "error", err.message);
              } finally {
                clearButtonLoading(e.target);
                doSearch();
              }
            },
          },
          ["パスワード再設定"]
        )
      );

      const emailCell = el("td", {}, [u.email]);
      if (u.registration_ip) {
        emailCell.appendChild(el("div", { class: "field-hint" }, [`IP: ${u.registration_ip}`]));
      }

      tbody.appendChild(
        el("tr", {}, [
          emailCell,
          el("td", {}, [u.username || "（未設定）"]),
          el("td", {}, tags),
          el("td", {}, actions),
        ])
      );
    }
    table.appendChild(tbody);
    resultsHost.appendChild(table);
  }

  async function act(path, method, body, triggerBtn) {
    if (triggerBtn) setButtonLoading(triggerBtn, "処理中...");
    try {
      const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "操作に失敗しました");
      doSearch();
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      if (triggerBtn) clearButtonLoading(triggerBtn);
    }
  }

  // タブを開いたら自動でアカウント一覧を読み込む（空検索=新しい順50件）
  doSearch();

  return container;
}

// ---------------------------------------------------------------------------
// スレッド管理タブ: 一覧表示・ID検索・非表示/表示・完全削除。
// 完全削除はmanifestで保存先シャードを解決し、レス全件ごと実DELETEする
// （サーバー側: handlePurgeThread参照）。
// ---------------------------------------------------------------------------
function buildThreadsPanel(bannerHost) {
  const container = el("div", {}, []);
  container.appendChild(
    el("p", { class: "field-hint" }, [
      "サーバー内のスレッド一覧（DB_MAIN保存分・新しい順・30件ずつ）。移行済み（shard1/shard2）のスレッドはID検索で探せます。",
    ])
  );

  const searchInput = el("input", { type: "text", inputmode: "numeric", placeholder: "スレッドIDで検索（例: 5）" }, []);
  const searchBtn = el("button", { class: "btn small", onclick: () => load(true) }, ["検索"]);
  const listBtn = el("button", { class: "btn small secondary", onclick: () => { searchInput.value = ""; load(true); } }, ["一覧に戻る"]);
  container.appendChild(el("div", { class: "form-actions" }, [searchInput, searchBtn, listBtn]));

  const listHost = el("div", {}, []);
  container.appendChild(listHost);

  const PAGE_SIZE = 30;
  let offset = 0;

  async function load(reset) {
    if (reset) {
      offset = 0;
      listHost.innerHTML = "";
      showSkeleton(listHost, 3);
    }
    try {
      const q = searchInput.value.trim();
      const url = q
        ? `/api/admin/threads?threadId=${encodeURIComponent(q)}`
        : `/api/admin/threads?limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await apiFetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "一覧の取得に失敗しました");

      const threads = data.threads || [];
      if (reset) listHost.innerHTML = "";
      const moreBtn = listHost.querySelector(".load-more");
      if (moreBtn) moreBtn.remove();

      if (reset && threads.length === 0) {
        listHost.appendChild(el("div", { class: "empty-state" }, [q ? "該当するスレッドが見つかりません" : "スレッドがまだありません"]));
        return;
      }
      for (const t of threads) listHost.appendChild(buildThreadRow(t));

      if (!q && threads.length === PAGE_SIZE) {
        listHost.appendChild(
          el(
            "button",
            {
              class: "btn secondary small load-more",
              style: "margin-top:8px;",
              onclick: (e) => {
                setButtonLoading(e.target, "読み込み中...");
                offset += threads.length;
                load(false).then(() => clearButtonLoading(e.target));
              },
            },
            ["さらに読み込む"]
          )
        );
      }
    } catch (err) {
      if (reset) listHost.innerHTML = "";
      showBanner(bannerHost, "error", err.message);
    }
  }

  function statusTag(status, shard) {
    const tags = [el("span", { class: `tag st-${status}` }, [status === "visible" ? "公開" : status === "hidden" ? "非表示" : "削除済"])];
    if (shard && shard !== "main") tags.push(el("span", { class: "tag st-shard" }, [shard]));
    return tags;
  }

  function buildThreadRow(t) {
    const actions = [];
    if (t.status === "hidden") {
      actions.push(
        el(
          "button",
          {
            class: "btn secondary small",
            onclick: (e) => act(`/api/admin/threads/${t.thread_id}/unhide`, e.target),
          },
          ["表示に戻す"]
        )
      );
    } else if (t.status === "visible") {
      actions.push(
        el(
          "button",
          {
            class: "btn secondary small",
            onclick: (e) => act(`/api/admin/threads/${t.thread_id}/hide`, e.target),
          },
          ["非表示"]
        )
      );
    }
    actions.push(
      el(
        "button",
        {
          class: "btn danger small",
          onclick: (e) => {
            if (!confirm(`スレッド「${t.title}」とレス${t.post_count}件を完全に削除します。\n元に戻せません。よろしいですか？`)) return;
            act(`/api/admin/threads/${t.thread_id}/purge`, e.target);
          },
        },
        ["完全削除"]
      )
    );

    return el("div", { class: "card thread-admin-row" }, [
      el("div", { class: "thread-admin-head" }, [
        el("a", { class: "thread-admin-title", href: `/thread.html?id=${t.thread_id}` }, [t.title]),
        el("span", { class: "tag" }, [`ID: ${t.thread_id}`]),
        ...statusTag(t.status, t.shard),
      ]),
      el("div", { class: "field-hint" }, [
        `スレ主: ${t.username || "名無しさん"} ・ レス ${t.post_count}件 ・ 最終更新: ${formatDate(t.last_activity_at)} ・ 保存先: ${t.shard}`,
      ]),
      el("div", { class: "form-actions" }, actions),
    ]);
  }

  async function act(path, triggerBtn) {
    if (triggerBtn) setButtonLoading(triggerBtn, "処理中...");
    try {
      const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "操作に失敗しました");
      showBanner(bannerHost, "success", "操作を完了しました");
      offset = 0;
      await load(true);
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      if (triggerBtn) clearButtonLoading(triggerBtn);
    }
  }

  load(true);

  return container;
}

const SETTING_GROUPS = [
  {
    title: "認証方式・データベース",
    hint: "認証方式は次回ログインから適用されます（既存のログイン状態は有効期限まで継続）。KVはどちらのモードでも使用しません。",
    fields: [
      {
        key: "auth_mode",
        label: "認証方式（JWT / HMACセッション）",
        select: [
          { value: "jwt", label: "JWT（ステートレス・KV/D1消費ゼロ・即時失効は不可）" },
          { value: "hmac", label: "HMACセッション（D1保存・認証毎にD1 read 1回・BAN/ログアウト即時失効）" },
        ],
      },
      {
        key: "db_shard_count",
        label: "使用するD1の数（1〜3）",
        select: [
          { value: "1", label: "1（DB_MAINのみ。移行なし・保持期間超過分はmainから削除）" },
          { value: "2", label: "2（main→shard1へ移行・保持期間超過分はshard1から削除）" },
          { value: "3", label: "3（main→shard1→shard2へ移行・従来動作）" },
        ],
      },
    ],
  },
  {
    title: "投稿制限",
    hint: "Free Planの負荷を抑えつつ荒らし対策をするための基本設定です。",
    fields: [
      { key: "daily_limit_new", label: "新規ユーザーの1日投稿数上限" },
      { key: "daily_limit_regular", label: "通常ユーザーの1日投稿数上限" },
      { key: "min_interval_new_sec", label: "新規ユーザーの投稿間隔（秒）" },
      { key: "min_interval_regular_sec", label: "通常ユーザーの投稿間隔（秒）" },
      { key: "max_body_len", label: "本文の最大文字数" },
      { key: "max_urls", label: "本文中の最大URL数" },
      { key: "promotion_distinct_days", label: "通常ユーザーへの昇格に必要な異なるログイン日数" },
    ],
  },
  {
    title: "Turnstile（Bot対策）",
    hint: "trueで有効、falseで無効になります。",
    fields: [
      { key: "require_turnstile_on_post", label: "投稿時にTurnstileを要求する (true/false)" },
      { key: "require_turnstile_on_auth", label: "登録・ログイン時にTurnstileを要求する (true/false)" },
    ],
  },
  {
    title: "ユーザー名",
    hint: "",
    fields: [
      { key: "username_min_len", label: "ユーザー名の最小文字数" },
      { key: "username_max_len", label: "ユーザー名の最大文字数" },
      { key: "username_daily_change_limit", label: "1日あたりのユーザー名変更回数上限" },
    ],
  },
  {
    title: "パスワード",
    hint: "最大文字数は新規登録時のみ適用されます（既存ユーザーのログインには影響しません）。",
    fields: [{ key: "password_max_len", label: "パスワードの最大文字数" }],
  },
  {
    title: "データ保持",
    hint: "「シャード移行」タブでの容量分散・自動削除に使われます。",
    fields: [{ key: "data_retention_days", label: "データ保持期間（日数）。Shard2でこれを超えたスレッドは自動削除の対象" }],
  },
  {
    title: "プライバシー・サーバー監視",
    hint:
      "登録IPの記録は既定でOFFです。ONにすると新規登録時にIPアドレスを保存します（過去の登録は遡って記録されません）。サーバー自動削除は日次ヘルスチェックで連続到達不能が続いたサーバーを全サーバーのリストから削除する機能です（2台以上の担当チェックの多数決で判定。単独報告ではカウントしません）。",
    fields: [
      { key: "record_registration_ip", label: "登録時にIPアドレスを記録する (0=OFF / 1=ON)" },
      { key: "server_auto_removal_days", label: "サーバー自動削除までの連続到達不能日数（1〜7）" },
    ],
  },
];

function buildSettingsPanel(bannerHost) {
  const container = el("div", {}, [el("div", { class: "card" }, [el("p", {}, ["読み込み中..."])])]);

  apiFetch("/api/admin/settings")
    .then((res) => res.json())
    .then((data) => {
      container.innerHTML = "";
      const inputs = {};

      for (const group of SETTING_GROUPS) {
        const groupCard = el("div", { class: "card" }, [el("label", { style: "font-size:15px;" }, [group.title])]);
        if (group.hint) groupCard.appendChild(el("p", { class: "field-hint" }, [group.hint]));
        for (const field of group.fields) {
          groupCard.appendChild(el("label", {}, [field.label]));
          let input;
          if (field.select) {
            // セレクトボックス型の設定項目（auth_mode / db_shard_countなど）
            input = el("select", {}, field.select.map((opt) => el("option", { value: opt.value }, [opt.label])));
            input.value = String(data.settings[field.key]);
          } else {
            input = el("input", { type: "text", value: String(data.settings[field.key]) }, []);
          }
          inputs[field.key] = input;
          groupCard.appendChild(input);
        }
        container.appendChild(groupCard);
      }

      const saveBtn = el(
        "button",
        {
          class: "btn",
          onclick: async () => {
            const body = {};
            for (const [key, input] of Object.entries(inputs)) body[key] = input.value;
            setButtonLoading(saveBtn, "保存中...");
            try {
              const res = await apiFetch("/api/admin/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              const d = await res.json();
              if (!res.ok) throw new Error(d.error ? d.error.message : "保存に失敗しました");
              showBanner(bannerHost, "success", "設定を保存しました");
            } catch (err) {
              showBanner(bannerHost, "error", err.message);
            } finally {
              clearButtonLoading(saveBtn);
            }
          },
        },
        ["まとめて保存"]
      );
      container.appendChild(el("div", { class: "form-actions" }, [saveBtn]));

      // 保存済み登録IPの一括消去（v10新設）。
      const purgeIpBtn = el(
        "button",
        {
          class: "btn danger",
          onclick: async () => {
            if (!confirm("保存済みの全ユーザーの登録IPアドレスを消去します。よろしいですか？")) return;
            setButtonLoading(purgeIpBtn, "消去中...");
            try {
              const res = await apiFetch("/api/admin/privacy/purge-registration-ips", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              const d = await res.json();
              if (!res.ok) throw new Error(d.error ? d.error.message : "消去に失敗しました");
              showBanner(bannerHost, "success", `${d.cleared ?? 0}件の登録IPを消去しました`);
            } catch (err) {
              showBanner(bannerHost, "error", err.message);
            } finally {
              clearButtonLoading(purgeIpBtn);
            }
          },
        },
        ["保存済みの登録IPを一括消去"]
      );
      container.appendChild(
        el("div", { class: "card danger-zone" }, [
          el("label", {}, ["プライバシー（危険操作）"]),
          el("p", { class: "field-hint" }, ["登録IPの記録をOFFにする場合、DBに残っている過去分も消すならこの操作を実行してください。操作は監査ログに記録されます。"]),
          el("div", { class: "form-actions" }, [purgeIpBtn]),
        ])
      );
    })
    .catch((err) => {
      container.innerHTML = "";
      showBanner(bannerHost, "error", err.message);
    });

  return container;
}

function buildShardPanel(bannerHost) {
  const sourceSelect = el("select", {}, [
    el("option", { value: "main" }, ["main"]),
    el("option", { value: "shard1" }, ["shard1"]),
  ]);
  const targetSelect = el("select", {}, [
    el("option", { value: "shard1" }, ["shard1"]),
    el("option", { value: "shard2" }, ["shard2"]),
  ]);
  const cutoffInput = el("input", { type: "text", value: "180" }, []);
  const batchInput = el("input", { type: "text", value: "20" }, []);
  const resultHost = el("pre", {}, []);

  const runBtn = el(
    "button",
    {
      class: "btn",
      onclick: async () => {
        setButtonLoading(runBtn, "実行中...");
        try {
          const res = await apiFetch("/api/admin/migrate-shard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceShard: sourceSelect.value,
              targetShard: targetSelect.value,
              cutoffDays: Number(cutoffInput.value),
              batchLimit: Number(batchInput.value),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ? data.error.message : "移行に失敗しました");
          resultHost.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          showBanner(bannerHost, "error", err.message);
        } finally {
          clearButtonLoading(runBtn);
        }
      },
    },
    ["このバッチを実行"]
  );

  const purgeShardSelect = el("select", {}, [
    el("option", { value: "shard2" }, ["shard2"]),
    el("option", { value: "shard1" }, ["shard1"]),
  ]);
  const purgeRetentionInput = el("input", { type: "text", placeholder: "空欄なら設定画面の保持期間を使用" }, []);
  const purgeResultHost = el("pre", {}, []);
  const purgeBtn = el(
    "button",
    {
      class: "btn danger",
      onclick: async () => {
        if (!confirm("保持期間を超えたスレッドを完全に削除します。元に戻せません。よろしいですか？")) return;
        setButtonLoading(purgeBtn, "削除中...");
        try {
          const res = await apiFetch("/api/admin/purge-expired", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shard: purgeShardSelect.value,
              retentionDays: purgeRetentionInput.value ? Number(purgeRetentionInput.value) : undefined,
              batchLimit: 20,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ? data.error.message : "削除に失敗しました");
          purgeResultHost.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          showBanner(bannerHost, "error", err.message);
        } finally {
          clearButtonLoading(purgeBtn);
        }
      },
    },
    ["保持期間超過分を削除"]
  );

  return el("div", {}, [
    el("div", { class: "card" }, [
      el("p", {}, ["最終活動が指定日数より古いスレッドを、少数件ずつ移行元から移行先シャードへ移します。"]),
      el("label", {}, ["移行元シャード"]),
      sourceSelect,
      el("label", {}, ["移行先シャード"]),
      targetSelect,
      el("label", {}, ["何日以上activityが無いスレッドを対象にするか"]),
      cutoffInput,
      el("label", {}, ["1回のバッチで処理する件数"]),
      batchInput,
      el("div", { class: "form-actions" }, [runBtn]),
      resultHost,
    ]),
    el("div", { class: "card" }, [
      el("p", {}, ["R2は使用していないため、これ以上移行できない場合は保持期間を超えたスレッドを完全に削除して容量を確保します。この操作は元に戻せません。"]),
      el("label", {}, ["対象シャード"]),
      purgeShardSelect,
      el("label", {}, ["保持期間（日数）"]),
      purgeRetentionInput,
      el("div", { class: "form-actions" }, [purgeBtn]),
      purgeResultHost,
    ]),
  ]);
}

function buildAuditPanel(bannerHost) {
  const host = el("div", {}, []);
  showSkeleton(host, 4);
  apiFetch("/api/admin/audit-log")
    .then((res) => res.json())
    .then((data) => {
      host.innerHTML = "";
      const table = el("table", { class: "admin-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["日時"]), el("th", {}, ["操作"]), el("th", {}, ["対象"])])]),
      ]);
      const tbody = el("tbody", {}, []);
      for (const log of data.logs) {
        tbody.appendChild(
          el("tr", {}, [el("td", {}, [formatDate(log.created_at)]), el("td", {}, [log.action]), el("td", {}, [log.target || ""])])
        );
      }
      table.appendChild(tbody);
      host.appendChild(table);
    })
    .catch((err) => showBanner(bannerHost, "error", err.message));
  return host;
}

function buildServersPanel(bannerHost) {
  const container = el("div", {}, []);
  const listHost = el("div", {}, [el("p", {}, ["読み込み中..."])]);

  async function reload() {
    showSkeleton(listHost, 2);
    try {
      const res = await fetch("/api/servers");
      const data = await res.json();
      listHost.innerHTML = "";
      const table = el("table", { class: "admin-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["名前"]), el("th", {}, ["URL"]), el("th", {}, ["稼働状態"]), el("th", {}, ["操作"])])]),
      ]);
      const tbody = el("tbody", {}, []);
      tbody.appendChild(el("tr", {}, [el("td", {}, [`${data.self.name}（自分）`]), el("td", {}, [data.self.url]), el("td", {}, [el("span", { class: "server-health up" }, ["稼働中"])]), el("td", {}, [])]));
      for (const s of data.servers || []) {
        const healthTags = [];
        const h = s.health === "up" || s.health === "down" ? s.health : "unknown";
        healthTags.push(el("span", { class: `server-health ${h}` }, [h === "up" ? "稼働中" : h === "down" ? "応答なし" : "未確認"]));
        if ((s.deadDays ?? 0) > 0) {
          healthTags.push(el("span", { class: "tag banned" }, [`到達不能${s.deadDays}日`]));
        }
        tbody.appendChild(
          el("tr", {}, [
            el("td", {}, [s.name]),
            el("td", {}, [s.url]),
            el("td", {}, healthTags),
            el(
              "td",
              {},
              [
                el(
                  "button",
                  {
                    class: "btn secondary small",
                    style: "margin-right:6px",
                    onclick: async (e) => {
                      await act("/api/admin/servers/check", { url: s.url }, e.target);
                    },
                  },
                  ["チェック"]
                ),
                el(
                  "button",
                  {
                    class: "btn danger small",
                    onclick: async (e) => {
                      if (!confirm(`${s.name} を一覧から削除しますか？`)) return;
                      await act("/api/admin/servers/remove", { url: s.url }, e.target);
                    },
                  },
                  ["削除"]
                ),
              ]
            ),
          ])
        );
      }
      table.appendChild(tbody);
      listHost.appendChild(table);
    } catch (err) {
      listHost.innerHTML = "";
      listHost.appendChild(el("div", { class: "banner error" }, ["一覧の取得に失敗しました"]));
    }
  }

  async function act(path, body, triggerBtn) {
    if (triggerBtn) setButtonLoading(triggerBtn, "処理中...");
    try {
      const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "操作に失敗しました");
      // サーバー追加・レスポンスチェックなど、結果の説明を返す操作はバナーで表示する
      // （チェックのdown結果は「応答なし」報告なのでinfo扱い・levelはサーバー側で決定）
      if (data.message) showBanner(bannerHost, data.level || "success", data.message);
      await reload();
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
    } finally {
      if (triggerBtn) clearButtonLoading(triggerBtn);
    }
  }

  const addUrlInput = el("input", { type: "text", placeholder: "https://other-server.example.workers.dev" }, []);
  const addNameInput = el("input", { type: "text", placeholder: "表示名（例: サーバー2）" }, []);
  const addBtn = el(
    "button",
    { class: "btn", onclick: (e) => act("/api/admin/servers", { url: addUrlInput.value, name: addNameInput.value }, e.target) },
    ["サーバーを追加"]
  );

  const pullUrlInput = el("input", { type: "text", placeholder: "https://other-server.example.workers.dev" }, []);
  const pullBtn = el(
    "button",
    { class: "btn secondary", onclick: (e) => act("/api/admin/servers/sync-pull", { peerUrl: pullUrlInput.value }, e.target) },
    ["このサーバーから一覧を取り込む"]
  );

  container.appendChild(
    el("div", { class: "card" }, [
      el("p", {}, ["別のcf-bbsサーバー（別アカウント上のデプロイ）を一覧に追加します。追加前にレスポンスを確認し、応答があれば「稼働中」として登録します。追加すると、既知の全サーバーへ自動で知らせます。"]),
      el("label", {}, ["URL"]),
      addUrlInput,
      el("label", {}, ["表示名"]),
      addNameInput,
      el("div", { class: "form-actions" }, [addBtn]),
    ])
  );

  container.appendChild(
    el("div", { class: "card" }, [
      el("p", {}, ["指定したサーバーが知っているサーバー一覧を取り込みます（手動での一覧同期）。"]),
      el("label", {}, ["取り込み元サーバーのURL"]),
      pullUrlInput,
      el("div", { class: "form-actions" }, [pullBtn]),
    ])
  );

  // 手動レスポンスチェックの説明（v11.2・一覧テーブルの上に固定表示するため
  // reload()で初期化されないlistHostの外に置く）
  container.appendChild(
    el("p", { class: "field-hint" }, [
      "「チェック」ボタンでそのサーバーへの応答を手動確認できます（管理者1人あたり1日10回まで・日本時間の0時にリセット）。応答があれば「稼働中」へ更新され、一時的なエラーで「応答なし」になっていたサーバーを復旧させられます（連続到達不能日数もリセット）。",
    ])
  );

  container.appendChild(listHost);
  reload();

  return container;
}
