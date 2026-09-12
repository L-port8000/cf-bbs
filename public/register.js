(async function main() {
  const bannerHost = document.getElementById("banner-host");
  const usernameInput = document.getElementById("username");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const submitBtn = document.getElementById("submit-btn");

  const turnstileHandle = await renderTurnstile("turnstile-container");

  // メールアドレス・パスワードは半角のみ入力できるようにする（要望仕様）。
  // ユーザー名は日本語も許可するため対象外。
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

    setButtonLoading(submitBtn, "登録中...");
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: usernameInput.value,
          email: emailInput.value,
          password: passwordInput.value,
          turnstileToken: turnstileHandle.getToken(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : "登録に失敗しました");
      window.location.href = "/index.html";
    } catch (err) {
      showBanner(bannerHost, "error", err.message);
      // 失敗したリクエストでTurnstileトークンは消費済み。同じトークンを
      // 再送すると「使用済み」扱いで必ず失敗するため、リトライ前に
      // ウィジェットをリセットして新しいトークンを取得させる。
      turnstileHandle.reset();
      clearButtonLoading(submitBtn);
    }
  });
})();
