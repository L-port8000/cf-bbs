(async function main() {
  const app = document.getElementById("app");
  const user = await requireLogin("/settings.html");
  if (!user) return;

  renderTopbar(app, user, "settings");
  app.appendChild(el("h2", {}, ["設定"]));

  const bannerHost = el("div", {}, []);
  app.appendChild(bannerHost);

  // ---- テーマ（一番上） ----
  app.appendChild(buildThemeCard());

  // ---- ユーザー名 ----
  app.appendChild(
    el("div", { class: "card" }, [
      el("label", {}, ["現在のユーザー名"]),
      el("p", {}, [user.username || "（未設定・「名無しさん」として投稿されます）"]),
    ])
  );

  const usernameInput = el("input", { type: "text", maxlength: "20", placeholder: "新しいユーザー名" }, []);
  const saveBtn = el("button", { class: "btn", onclick: onSave }, ["ユーザー名を変更"]);

  app.appendChild(
    el("div", { class: "card" }, [
      el("label", {}, ["ユーザー名を変更"]),
      usernameInput,
      el("p", { class: "field-hint" }, ["1日に変更できる回数には上限があります（上限値は管理者が設定）。過去の投稿の表示名は変わりません。"]),
      el("div", { class: "form-actions" }, [saveBtn]),
    ])
  );

  // ---- メールアドレス変更 ----
  app.appendChild(buildEmailCard(user, bannerHost));

  // ---- パスワード変更 ----
  app.appendChild(buildPasswordCard(bannerHost));

  // ---- サーバー一覧 ----
  app.appendChild(buildServerListCard(bannerHost));

  // ---- 高度な機能（折りたたみ・v11新設。中にAPIキー管理を同梱） ----
  app.appendChild(buildAdvancedCard(bannerHost));

  // ---- ログアウト + アカウント削除（一番下） ----
  app.appendChild(
    el("div", { class: "card logout-card" }, [
      el("label", {}, ["アカウント"]),
      el("div", { class: "form-actions" }, [el("button", { class: "btn danger", onclick: onLogoutClick }, ["ログアウト"])]),
    ])
  );
  app.appendChild(buildDeleteAccountCard(bannerHost));

  // ---- 利用規約へのリンク（ページ最下部・v10新設） ----
  app.appendChild(
    el("div", { class: "card terms-card" }, [
      el("label", {}, ["利用規約"]),
      el("p", { class: "field-hint" }, ["本サーバーのご利用にあたっての利用規約です。登録・投稿前にご確認ください。"]),
      el("div", { class: "form-actions" }, [
        el("a", { class: "btn secondary small", href: "/terms.html", target: "_blank", rel: "noopener" }, ["利用規約を開く"]),
      ]),
    ])
  );

  async function onSave() {
    setButtonLoading(saveBtn, "変更中...");
    bannerHost.innerHTML = "";
    try {
      const res = await apiFetch("/api/auth/username", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "変更に失敗しました");
      showBanner(bannerHost, "success", `ユーザー名を「${data.username}」に変更しました`);
      usernameInput.value = "";
      clearButtonLoading(saveBtn);
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      clearButtonLoading(saveBtn);
    }
  }
})();

// ---------------------------------------------------------------------------
// テーマ選択（ダークモード / ホワイトモード）。
// 選択はlocalStorageに保存され、全ページの<head>でtheme.jsが事前適用する。
// ---------------------------------------------------------------------------
function buildThemeCard() {
  const darkBtn = el("button", { class: "btn small", onclick: () => select("dark") }, ["ダークモード"]);
  const lightBtn = el("button", { class: "btn small secondary", onclick: () => select("light") }, ["ホワイトモード"]);

  function reflect() {
    const current = getStoredTheme();
    darkBtn.className = "btn small" + (current === "dark" ? "" : " secondary");
    lightBtn.className = "btn small" + (current === "light" ? "" : " secondary");
  }

  function select(theme) {
    applyTheme(theme);
    reflect();
  }

  reflect();

  return el("div", { class: "card" }, [
    el("label", {}, ["テーマ"]),
    el("p", { class: "field-hint" }, ["見た目の色を選べます。選択はこのブラウザに保存されます。"]),
    el("div", { class: "form-actions" }, [darkBtn, lightBtn]),
  ]);
}

// ---------------------------------------------------------------------------
// メールアドレス変更。
// 現在のパスワードの再入力を必須にする（離席中の端末での勝手な変更防止）。
// 成功後は再ログイン不要。画面表示のメールアドレスも即座に差し替える。
// ---------------------------------------------------------------------------
function buildEmailCard(user, bannerHost) {
  const currentLabel = el("p", {}, [user.email]);
  const emailInput = el("input", { type: "text", inputmode: "email", maxlength: "254", placeholder: "新しいメールアドレス", autocomplete: "email" }, []);
  const passInput = el("input", { type: "password", placeholder: "現在のパスワード", autocomplete: "current-password" }, []);
  restrictHalfWidth(emailInput);
  restrictHalfWidth(passInput);
  const btn = el("button", { class: "btn", onclick: onChange }, ["メールアドレスを変更"]);

  async function onChange() {
    bannerHost.innerHTML = "";
    const newEmail = emailInput.value.trim();
    if (!newEmail || !passInput.value) {
      showBanner(bannerHost, "error", "新しいメールアドレスと現在のパスワードを入力してください");
      return;
    }
    setButtonLoading(btn, "変更中...");
    try {
      const res = await apiFetch("/api/auth/email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail, currentPassword: passInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "変更に失敗しました");
      currentLabel.textContent = data.email;
      user.email = data.email;
      emailInput.value = "";
      passInput.value = "";
      showBanner(bannerHost, "success", `メールアドレスを「${data.email}」に変更しました（再ログインは不要です）`);
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
    } finally {
      clearButtonLoading(btn);
    }
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["メールアドレス"]),
    currentLabel,
    el("p", { class: "field-hint" }, ["ログインやお知らせに使うメールアドレスを変更できます。変更には現在のパスワードが必要です。"]),
    emailInput,
    passInput,
    el("div", { class: "form-actions" }, [btn]),
  ]);
}

// ---------------------------------------------------------------------------
// パスワード変更。
// 変更に成功すると他の端末のセッションは失効する（HMACモードは即時、
// JWTモードはトークン期限まで。サーバー側の仕様はREADME参照）。
// この端末は新しいセッションが発行されるため再ログインは不要。
// ---------------------------------------------------------------------------
function buildPasswordCard(bannerHost) {
  const currentInput = el("input", { type: "password", placeholder: "現在のパスワード", autocomplete: "current-password" }, []);
  const newInput = el("input", { type: "password", placeholder: "新しいパスワード（8文字以上・半角）", autocomplete: "new-password" }, []);
  const confirmInput = el("input", { type: "password", placeholder: "新しいパスワード（確認用）", autocomplete: "new-password" }, []);
  restrictHalfWidth(currentInput);
  restrictHalfWidth(newInput);
  restrictHalfWidth(confirmInput);
  const btn = el("button", { class: "btn", onclick: onChange }, ["パスワードを変更"]);

  async function onChange() {
    bannerHost.innerHTML = "";
    if (!currentInput.value || !newInput.value) {
      showBanner(bannerHost, "error", "現在のパスワードと新しいパスワードを入力してください");
      return;
    }
    if (newInput.value.length < 8) {
      showBanner(bannerHost, "error", "新しいパスワードは8文字以上にしてください");
      return;
    }
    if (newInput.value !== confirmInput.value) {
      showBanner(bannerHost, "error", "新しいパスワード（確認用）が一致しません");
      return;
    }
    setButtonLoading(btn, "変更中...");
    try {
      const res = await apiFetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentInput.value, newPassword: newInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "変更に失敗しました");
      currentInput.value = "";
      newInput.value = "";
      confirmInput.value = "";
      showBanner(bannerHost, "success", "パスワードを変更しました。他の端末のセッションはログアウトされます（この端末はログインしたままです）");
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
    } finally {
      clearButtonLoading(btn);
    }
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["パスワード変更"]),
    el("p", { class: "field-hint" }, ["変更には現在のパスワードが必要です。変更後、他の端末に残る古いセッションは無効になります。"]),
    currentInput,
    newInput,
    confirmInput,
    el("div", { class: "form-actions" }, [btn]),
  ]);
}

// ---------------------------------------------------------------------------
// アカウント削除（退会）。取り返しがつかないため、確認語「削除」の入力と
// 現在のパスワードの両方を要求する。削除後は板トップへリダイレクトする。
// 投稿・スレッド自体は残り、表示名が「名無しさん」に変わる（README参照）。
// ---------------------------------------------------------------------------
function buildDeleteAccountCard(bannerHost) {
  const passInput = el("input", { type: "password", placeholder: "現在のパスワード", autocomplete: "current-password" }, []);
  const confirmInput = el("input", { type: "text", maxlength: 10, placeholder: "確認のため「削除」と入力" }, []);
  restrictHalfWidth(passInput);
  const btn = el("button", { class: "btn danger", onclick: onDelete }, ["アカウントを削除する"]);

  async function onDelete() {
    bannerHost.innerHTML = "";
    if (!passInput.value) {
      showBanner(bannerHost, "error", "現在のパスワードを入力してください");
      return;
    }
    if (confirmInput.value.trim() !== "削除") {
      showBanner(bannerHost, "error", "確認のため「削除」と入力してください");
      return;
    }
    if (!window.confirm("本当にアカウントを削除しますか？この操作は取り消せません。")) return;
    setButtonLoading(btn, "削除中...");
    try {
      const res = await apiFetch("/api/auth/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: passInput.value, confirm: confirmInput.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "削除に失敗しました");
      window.location.href = "/index.html";
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      clearButtonLoading(btn);
    }
  }

  return el("div", { class: "card danger-zone" }, [
    el("label", {}, ["アカウントを削除"]),
    el("p", { class: "field-hint" }, [
      "削除すると元に戻せません。あなたの投稿とスレッドは残りますが、表示名は「名無しさん」に変わります。同じメールアドレス・ユーザー名での再登録も可能になります。",
    ]),
    passInput,
    confirmInput,
    el("div", { class: "form-actions" }, [btn]),
  ]);
}

// ---------------------------------------------------------------------------
// サーバー一覧。
// 「サーバ一覧を開く」を押すと選択画面が開き、既知のサーバーが一覧表示される。
// 各サーバーは「開く」で板に直接アクセスできる（別サーバーは読み取り専用）。
// また、ログインユーザーは自分が立てた別のcf-bbsサーバーをここから登録できる。
// 登録時にはサーバー側で実在確認（cf-bbsとして応答するか）が行われ、
// 登録済みの他サーバーへも自動で告知（announce）される。
// ---------------------------------------------------------------------------
function buildServerListCard(bannerHost) {
  const panel = el("div", { class: "server-panel", style: "display:none;" }, []);
  const toggleBtn = el("button", { class: "btn secondary", onclick: toggle }, ["サーバ一覧を開く"]);
  let opened = false;
  let loaded = false;

  async function toggle() {
    opened = !opened;
    panel.style.display = opened ? "" : "none";
    toggleBtn.textContent = opened ? "閉じる" : "サーバ一覧を開く";
    if (opened && !loaded) await refresh();
  }

  async function refresh() {
    panel.innerHTML = "";
    panel.appendChild(el("p", { class: "field-hint" }, ["読み込み中..."]));
    try {
      const res = await apiFetch("/api/servers");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "一覧の取得に失敗しました");

      panel.innerHTML = "";
      loaded = true;
      const entries = [{ ...data.self, self: true }, ...(data.servers || []).map((s) => ({ ...s, self: false }))];
      if (entries.length === 1) {
        panel.appendChild(el("p", { class: "field-hint" }, ["まだ他のサーバーは登録されていません。下のフォームから追加できます。"]));
      }
      for (const s of entries) {
        panel.appendChild(buildServerRow(s));
      }

      panel.appendChild(buildRegisterForm());
    } catch (err) {
      panel.innerHTML = "";
      panel.appendChild(el("div", { class: "banner error" }, [err.message]));
    }
  }

  function buildServerRow(s) {
    // お気に入り（★）トグル。自分のサーバーは常にホームに表示されるため対象外。
    // 押したらボタンの見た目だけ更新する（再取得は不要なため行わない）。
    const star = s.self
      ? null
      : el(
          "button",
          {
            class: "star-btn" + (isFavoriteServer(s.url) ? " active" : ""),
            title: isFavoriteServer(s.url) ? "お気に入りから削除" : "お気に入りに追加",
            "aria-label": `${s.name}をお気に入り${isFavoriteServer(s.url) ? "から削除" : "に追加"}`,
            onclick: () => {
              const added = toggleFavoriteServer(s.url);
              star.textContent = added ? "★" : "☆";
              star.classList.toggle("active", added);
              star.title = added ? "お気に入りから削除" : "お気に入りに追加";
            },
          },
          [isFavoriteServer(s.url) ? "★" : "☆"]
        );
    const rowChildren = [
      serverIcon(s.type || "normal"),
      el("div", { class: "grow" }, [
        el("div", { class: "server-name" }, [s.self ? `${s.name}（自分）` : s.name]),
        el("div", { class: "server-url" }, [s.url]),
      ]),
      healthBadge(s),
      star,
      el(
        "button",
        { class: "btn small secondary", onclick: () => (window.location.href = s.self ? "/index.html" : `/index.html?server=${encodeURIComponent(s.url)}`) },
        ["開く"]
      ),
    ].filter(Boolean);
    return el("div", { class: "server-row" }, rowChildren);
  }

  // 日次ヘルスチェック（0:00 JST）の結果バッジ。downでも「開く」は可能
  // （誤検知の可能性もあるため）。未確認はunknownとして表示する。
  // 連続到達不能日数（deadDays・自動削除カウンタ）も表示する（v10新設）。
  function healthBadge(s) {
    const h = s.self ? "up" : s.health === "up" || s.health === "down" ? s.health : "unknown";
    const dead = !s.self && typeof s.deadDays === "number" && s.deadDays > 0 ? s.deadDays : 0;
    const label =
      h === "up" ? "稼働中" : h === "down" ? (dead > 0 ? `応答なし(${dead}日)` : "応答なし") : "未確認";
    const span = el("span", { class: `server-health ${h}` }, [label]);
    if (!s.self && typeof s.lastHealthAt === "number") {
      span.title =
        dead > 0
          ? `最終確認: ${formatDate(s.lastHealthAt)} ・ 連続${dead}日到達不能（${dead}日以上続くと自動削除対象）`
          : `最終確認: ${formatDate(s.lastHealthAt)}`;
    }
    return span;
  }

  function buildRegisterForm() {
    const urlInput = el("input", { type: "text", inputmode: "url", placeholder: "https://あなたのサーバー.workers.dev" }, []);
    const nameInput = el("input", { type: "text", maxlength: "60", placeholder: "サーバーの名前（例: サーバー2）" }, []);
    const addBtn = el("button", { class: "btn", onclick: onAdd }, ["サーバーを追加"]);

    async function onAdd() {
      setButtonLoading(addBtn, "確認中...");
      bannerHost.innerHTML = "";
      try {
        const res = await apiFetch("/api/servers/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: urlInput.value.trim(), name: nameInput.value.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ? data.error.message : "追加に失敗しました");
        showBanner(bannerHost, "success", `サーバー「${data.name}」を登録しました。他のサーバーにも自動で通知されます`);
        urlInput.value = "";
        nameInput.value = "";
        clearButtonLoading(addBtn);
        await refresh();
      } catch (err) {
        showBanner(bannerHost, "error", err.message);
        clearButtonLoading(addBtn);
      }
    }

    return el("div", { class: "server-register" }, [
      el("label", {}, ["新しいサーバーを追加"]),
      el("p", { class: "field-hint" }, [
        "自分で立てた別のcf-bbsサーバー（独自D1）のURLを登録できます。登録前に相手がcf-bbsとして応答するか自動確認し、登録済みのサーバーへも一覧が共有されます。",
      ]),
      urlInput,
      nameInput,
      el("div", { class: "form-actions" }, [addBtn]),
    ]);
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["サーバ一覧"]),
    el("p", { class: "field-hint" }, ["他の人が立てたcf-bbsサーバーを選んで閲覧できます（別サーバーは読み取り専用）。★でホーム画面へのお気に入り登録もできます。"]),
    el("div", { class: "form-actions" }, [toggleBtn]),
    panel,
  ]);
}

// ---------------------------------------------------------------------------
// 高度な機能（v11新設）。
// 折りたたまれており「開く」を押すと内部の機能が表示される。現在の内容:
//   - APIキー管理（外部ツール用の正規認証経路）
// 既定では外部ツールからの書き込みAPIはサーバー側のOrigin検証で拒否されるため、
// 外部ツールを使いたいユーザーだけが自分のキーを発行する設計。
// キーは発行時に一度だけ全文表示され、以後は先頭13文字（cfbk_+8・key_prefix）のみ。
// ---------------------------------------------------------------------------
function buildAdvancedCard(bannerHost) {
  // 発行直後の「一度だけ表示」領域。パネル（一覧）の再描画で消えないよう外側に置く
  const onceBox = el("div", {}, []);
  const panel = el("div", { class: "server-panel", style: "display:none;" }, []);
  const toggleBtn = el("button", { class: "btn secondary", onclick: toggle }, ["開く"]);
  let opened = false;
  let loaded = false;

  async function toggle() {
    opened = !opened;
    panel.style.display = opened ? "" : "none";
    toggleBtn.textContent = opened ? "閉じる" : "開く";
    if (opened && !loaded) await refresh();
  }

  async function refresh() {
    panel.innerHTML = "";
    panel.appendChild(el("p", { class: "field-hint" }, ["読み込み中..."]));
    try {
      const res = await apiFetch("/api/auth/api-keys");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "一覧の取得に失敗しました");
      loaded = true;
      panel.innerHTML = "";
      panel.appendChild(buildApiKeySection(data.keys || []));
    } catch (err) {
      panel.innerHTML = "";
      panel.appendChild(el("div", { class: "banner error" }, [err.message]));
    }
  }

  function buildApiKeySection(keys) {
    const wrap = el("div", {}, []);

    wrap.appendChild(el("h3", { class: "advanced-subtitle" }, ["APIキー"]));
    wrap.appendChild(
      el("p", { class: "field-hint" }, [
        "外部ツール（curl・自作スクリプト等）から投稿などのAPIを呼び出すためのキーです。既定では外部ツールからの書き込みAPIは拒否されますが、このキーを「Authorization: Bearer」ヘッダで送ると許可されます。キーを知っている人はあなたとして投稿できるため、取り扱いに注意してください。管理者用の操作（管理画面のAPI）には使えません。",
      ])
    );

    // 発行フォーム
    const labelInput = el("input", { type: "text", maxlength: "30", placeholder: "キーの名前（例: 自作ツール）" }, []);
    const createBtn = el("button", { class: "btn", onclick: onCreate }, ["APIキーを発行"]);
    async function onCreate() {
      bannerHost.innerHTML = "";
      const label = labelInput.value.trim();
      if (!label) {
        showBanner(bannerHost, "error", "キーの名前を入力してください");
        return;
      }
      setButtonLoading(createBtn, "発行中...");
      try {
        const res = await apiFetch("/api/auth/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ? data.error.message : "発行に失敗しました");
        labelInput.value = "";
        clearButtonLoading(createBtn);
        showKeyOnce(data.key);
        await refresh();
      } catch (err) {
        showBanner(bannerHost, "error", err.message);
        clearButtonLoading(createBtn);
      }
    }
    wrap.appendChild(
      el("div", { class: "server-register" }, [
        el("label", {}, ["新しいAPIキーを発行"]),
        labelInput,
        el("div", { class: "form-actions" }, [createBtn]),
      ])
    );

    // 既存キーの一覧（全文は表示しない・先頭12文字のみ）
    if (keys.length === 0) {
      wrap.appendChild(el("p", { class: "field-hint" }, ["APIキーはまだありません。上のフォームから発行できます。"]));
    } else {
      for (const k of keys) wrap.appendChild(buildKeyRow(k));
    }

    // 使い方（curl例）
    wrap.appendChild(el("p", { class: "field-hint", style: "margin-top:12px;" }, ["外部ツールからの呼び出し例（スレッドへの返信）:"]));
    wrap.appendChild(
      el("pre", { class: "api-key-snippet" }, [
        `curl -X POST ${window.location.origin}/api/threads/<スレッドID>/posts \\\n  -H "Authorization: Bearer <あなたのAPIキー>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"body":"APIキーからの投稿"}'`,
      ])
    );

    return wrap;
  }

  // キー全文はここで一度だけ表示する（ページを再読み込みすると消える）
  function showKeyOnce(key) {
    onceBox.innerHTML = "";
    const copyBtn = el("button", { class: "btn small secondary", onclick: copy }, ["コピー"]);
    function copy() {
      navigator.clipboard
        .writeText(key)
        .then(() => {
          copyBtn.textContent = "コピーしました";
          setTimeout(() => (copyBtn.textContent = "コピー"), 1500);
        })
        .catch(() => {
          showBanner(bannerHost, "error", "コピーに失敗しました。キーを手動で選択してください");
        });
    }
    onceBox.appendChild(
      el("div", { class: "banner success" }, [
        el("div", {}, ["APIキーを発行しました。下のキーは二度と表示されないため、今すぐコピーして保存してください:"]),
        el("div", { class: "api-key-value" }, [key]),
        el("div", { class: "api-key-actions" }, [copyBtn]),
      ])
    );
    onceBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function buildKeyRow(k) {
    const revokeBtn = el("button", { class: "btn small danger", onclick: onRevoke }, ["失効"]);
    async function onRevoke() {
      if (!window.confirm(`APIキー「${k.label}」を失効させますか？このキーを使うツールは直ちに動かなくなります。`)) return;
      setButtonLoading(revokeBtn, "失効中...");
      bannerHost.innerHTML = "";
      try {
        const res = await apiFetch(`/api/auth/api-keys/${encodeURIComponent(k.key_id)}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ? data.error.message : "失効に失敗しました");
        showBanner(bannerHost, "success", `APIキー「${k.label}」を失効させました`);
        await refresh();
      } catch (err) {
        showBanner(bannerHost, "error", err.message);
        clearButtonLoading(revokeBtn);
      }
    }
    return el("div", { class: "server-row" }, [
      el("div", { class: "grow" }, [
        el("div", { class: "server-name" }, [k.label]),
        el("div", { class: "server-url" }, [`${k.key_prefix}…`]),
        el("div", { class: "field-hint" }, [
          `作成: ${formatDate(k.created_at)} ・ 最終使用: ${k.last_used_at ? formatDate(k.last_used_at) : "未使用"}`,
        ]),
      ]),
      revokeBtn,
    ]);
  }

  return el("div", { class: "card" }, [
    el("label", {}, ["高度な機能"]),
    el("p", { class: "field-hint" }, ["上級者向けの機能です。「開く」で内容が表示されます。"]),
    el("div", { class: "form-actions" }, [toggleBtn]),
    onceBox,
    panel,
  ]);
}
