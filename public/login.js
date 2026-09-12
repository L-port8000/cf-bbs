(async function main() {
  const bannerHost = document.getElementById("banner-host");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const submitBtn = document.getElementById("submit-btn");

  const turnstileHandle = await renderTurnstile("turnstile-container");

  // メールアドレス・パスワードは半角のみ入力できるようにする（要望仕様）。
  // 全角・日本語等は入力した瞬間に自動で除去される。
  restrictHalfWidth(emailInput);
  restrictHalfWidth(passwordInput);

  submitBtn.addEventListener("click", async () => {
    bannerHost.innerHTML = "";
    // Turnstileのトークンがまだ発行されていない（ウィジェット処理中など）場合、
    // このまま送信してもサーバー側で必ず失敗するため、ここで案内して中断する
    // （トークンには約5分の有効期限があり、期限切れ直後もここに該当する）。
    let turnstileOnAuth = true;
    try {
      const config = await getPublicConfig();
      if (config && config.turnstileOnAuth === false) turnstileOnAuth = false;
    } catch {
      /* 取得できない場合は安全側（トークン必須）として扱う */
    }
    if (turnstileOnAuth && !turnstileHandle.getToken()) {
      turnstileHandle.reset();
      showBanner(bannerHost, "error", "Turnstileの認証準備ができていません。少し待ってからもう一度お試しください");
      return;
    }

    setButtonLoading(submitBtn, "ログイン中...");
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailInput.value,
          password: passwordInput.value,
          turnstileToken: turnstileHandle.getToken(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "ログインに失敗しました");

      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get("next") || "/index.html";
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      // 失敗したリクエストでTurnstileトークンは消費済み（パスワード間違いで
      // 失敗した場合も消費されている）。同じトークンを再送すると「使用済み」
      // 扱いで必ず失敗するため、リトライ前にウィジェットをリセットして
      // 新しいトークンを取得させる。
      turnstileHandle.reset();
      clearButtonLoading(submitBtn);
    }
  });
})();
