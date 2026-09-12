(async function main() {
  const app = document.getElementById("app");
  const user = await requireLogin("/status.html");
  if (!user) return;

  // 利用状況はログイン済みの全ユーザーが閲覧できる（要望仕様。管理者限定から変更）

  renderTopbar(app, user, "status");
  app.appendChild(el("h2", {}, ["Free Plan 利用状況（推定）"]));
  app.appendChild(
    el("p", { class: "field-hint" }, [
      "Cloudflareの集計APIから取得した本日分のおおよその利用率です。数分程度のタイムラグやキャッシュ（5分間）があります。",
      el("br"),
      "日次集計の区切りは毎日 0:03（日本時間）です（0:00〜0:02の死活監視通信を前日に含めないため）。D1/KVの利用量はCloudflare基準（UTC 0:00＝日本時間 9:00）でリセットされます。",
    ])
  );

  const host = el("div", {}, [el("div", { class: "skeleton" }), el("div", { class: "skeleton" })]);
  app.appendChild(host);

  try {
    const res = await apiFetch("/api/status");
    const data = await res.json();
    host.innerHTML = "";

    if (!data.configured) {
      host.appendChild(el("div", { class: "banner info" }, [data.message || "この機能は設定されていません"]));
      return;
    }

    host.appendChild(renderMetricCard("Workers（本日のリクエスト数）", data.workers));

    for (const db of data.d1) {
      host.appendChild(renderD1Card(db));
    }

    host.appendChild(renderKvCard(data.kv));
  } catch (err) {
    host.innerHTML = "";
    host.appendChild(el("div", { class: "banner error" }, ["利用状況の取得に失敗しました"]));
  }

  function bar(percent) {
    const pct = Math.min(100, Math.max(0, percent || 0));
    const color = pct > 90 ? "var(--red)" : pct > 70 ? "var(--yellow)" : "var(--green)";
    return el("div", { style: "background:var(--surface0); border-radius:999px; height:8px; overflow:hidden; margin-top:6px;" }, [
      el("div", { style: `background:${color}; width:${pct}%; height:100%;` }, []),
    ]);
  }

  function renderMetricCard(title, metric) {
    if (!metric || metric.error) {
      return el("div", { class: "card" }, [el("label", {}, [title]), el("p", { class: "field-hint" }, [metric && metric.error ? "取得できませんでした" : "データなし"])]);
    }
    return el("div", { class: "card" }, [
      el("label", {}, [title]),
      el("p", {}, [`${metric.requestsToday.toLocaleString()} / ${metric.limit.toLocaleString()} (${metric.percent}%)`]),
      bar(metric.percent),
    ]);
  }

  function renderD1Card(db) {
    const rows = [];
    rows.push(el("label", {}, [`D1: ${db.binding}`]));
    if (db.storageBytes !== undefined) {
      const mb = (db.storageBytes / 1024 / 1024).toFixed(1);
      rows.push(el("p", {}, [`ストレージ: ${mb} MB (${db.storagePercent}% / 5GB)`]));
      rows.push(bar(db.storagePercent));
    }
    if (db.rowsReadToday !== undefined) {
      rows.push(el("p", {}, [`本日の読み取り: ${db.rowsReadToday.toLocaleString()} (${db.rowsReadPercent}%)`]));
      rows.push(el("p", {}, [`本日の書き込み: ${db.rowsWrittenToday.toLocaleString()} (${db.rowsWrittenPercent}%)`]));
    }
    if (db.error && db.storageBytes === undefined) {
      rows.push(el("p", { class: "field-hint" }, ["取得できませんでした"]));
    }
    return el("div", { class: "card" }, rows);
  }

  function renderKvCard(kv) {
    if (!kv || kv.error) {
      return el("div", { class: "card" }, [el("label", {}, ["KV (SESSIONS_KV)"]), el("p", { class: "field-hint" }, ["取得できませんでした"])]);
    }
    return el("div", { class: "card" }, [
      el("label", {}, ["KV (SESSIONS_KV)"]),
      el("p", {}, [`本日の読み取り: ${kv.readsToday} (${kv.readPercent}%)`]),
      el("p", {}, [`本日の書き込み: ${kv.writesToday} (${kv.writePercent}%)`]),
      bar(kv.writePercent),
    ]);
  }
})();
