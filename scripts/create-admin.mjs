#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cf-bbs 管理者アカウント作成スクリプト（CLIからD1へ直接登録する）
//
// 使い方（プロジェクトルートで実行）:
//   node scripts/create-admin.mjs
//
// オプション（対話を省略したい場合）:
//   node scripts/create-admin.mjs --email admin@example.com --password 'pass1234' \
//        --username admin --pepper 'xxxx' [--local]
//
// できること:
//   - users テーブルへ role='admin' のアカウントを登録（既にメールが存在する
//     場合はその行のパスワードをリセットして admin 化するUPSERT動作）
//   - パスワードは平文で保存せず、Worker本体(src/utils/crypto.ts)と完全に同じ
//     方式（PBKDF2-SHA256 / 100,000反復 / 16バイトソルト / base64url）で
//     ハッシュ化して保存する
//
// PASSWORD_PEPPERについて:
//   Workerはパスワード検証時「PEPPER:パスワード」の形でPBKDF2にかけるため、
//   ここで計算するハッシュにも本番と同じPEPPERが必要です。
//   - `wrangler secret list` に PASSWORD_PEPPER が無い場合、Workerは
//     未設定(undefined)のまま動いているため、PEPPER入力は空でOKです
//     （スクリプトが自動で判定・警告します）。
//   - 設定済みの場合は `wrangler secret put PASSWORD_PEPPER` で入れたのと
//     同じ値を入力してください（.dev.vars に書いてあれば自動読み込みします）。
//
// 注意:
//   セッションにはログイン時点のroleが記録されるため、既にログイン済みの
//   アカウントをadmin化した場合は一度ログアウト→再ログインしてください。
//
// v2修正（2026-09-08）:
//   - TTY対話モードでEnterを検出できず固まる不具合を修正
//     （stdinは既定でBufferで届くため文字列と===比較しても一致しない。
//      setEncoding("utf8")を明示し、改行位置で行を確定する方式に変更）
//   - パスワード入力中に「*」を表示するように改善（実際の文字は保持しない）
// ---------------------------------------------------------------------------

import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;
// 注意: getRandomValuesはメソッド抽出して呼ぶとNodeのwebcryptoで
// ERR_INVALID_THISになるため、必ずcryptoオブジェクトのメソッドとして呼ぶ
function getRandomValues(arr) {
  const c = globalThis.crypto ?? webcrypto;
  return c.getRandomValues(arr);
}

// ---------------------------------------------------------------------------
// 引数解析
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`cf-bbs 管理者アカウント作成スクリプト

使い方:
  node scripts/create-admin.mjs                                （対話モード）
  node scripts/create-admin.mjs --email a@b.c --password 'xxx' （対話を省略）

オプション:
  --email <addr>       管理者のメールアドレス（半角）
  --password <pass>    パスワード（8文字以上・半角・対話入力中は*で表示）
  --username <name>    表示用ユーザー名（任意）
  --pepper <pepper>    PASSWORD_PEPPER（未指定なら自動判定または対話入力）
  --iterations <n>     PBKDF2反復回数（既定100000）
  --local              本番ではなくローカルD1へ登録（開発・テスト用）
  --help               このヘルプを表示`);
  process.exit(0);
}
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
const flagLocal = args.includes("--local");
const argEmail = argValue("--email");
const argPassword = argValue("--password");
const argUsername = argValue("--username");
const argPepper = argValue("--pepper");
const argIterations = Number(argValue("--iterations") ?? 100_000) || 100_000;

// ---------------------------------------------------------------------------
// 対話入力ヘルパー
// ---------------------------------------------------------------------------

function askVisible(question, defaultValue = "") {
  // 標準入力がTTYでない（cron/CI/パイプ）場合は待ち受けず既定値を返す
  if (!process.stdin.isTTY) return Promise.resolve(defaultValue);
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8"); // Bufferのままだと "\n" との===比較が常にfalseになる
    let buf = "";
    const onData = (chunk) => {
      // 通常（カノニカル）モードではEnterごとに「1行+改行」がまとめて届く。
      // chunk全体を"\n"と比較しても一致しないため、改行位置で分割して判定する
      const nl = chunk.indexOf("\n");
      const head = (nl === -1 ? chunk : chunk.slice(0, nl)).replace(/\r/g, "");
      buf += head;
      if (nl === -1) return; // まだ改行が届いていない
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(buf || defaultValue);
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8"); // Bufferのままだと "\r" との===比較が常にfalseになる
    const chars = [];
    let escapeSeq = false; // 矢印キー等のエスケープシーケンス（ESC始まり）を読み飛ばす
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(chars.join(""));
          return;
        } else if (ch === "\u0003") {
          // Ctrl+C
          process.exit(1);
        } else if (ch === "\u001B") {
          escapeSeq = true;
        } else if (escapeSeq) {
          if (/[a-zA-Z~]/.test(ch)) escapeSeq = false; // シーケンス終端
        } else if (ch === "\u007F" || ch === "\b") {
          // Backspace: 直前の*を消す
          if (chars.length > 0) {
            chars.pop();
            process.stdout.write("\b \b");
          }
        } else if (ch >= " " && ch <= "~") {
          // 半角印字可能文字のみ受け付け（全角は*も出ずに無視される）
          chars.push(ch);
          process.stdout.write("*"); // 見た目は*のみ。実際の文字は保持しない
        }
        // その他の制御文字は無視
      }
    };
    function cleanup() {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// PASSWORD_PEPPER の推定（本番Workerの実挙動に合わせる）
// ---------------------------------------------------------------------------

function readPepperFromDevVars() {
  const p = path.resolve(process.cwd(), ".dev.vars");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*PASSWORD_PEPPER\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) return m[1] ?? "";
  }
  return null;
}

function listSecretNames() {
  // wrangler secret list の出力（JSON配列 or テーブル）からシークレット名を抽出する
  const res = spawnSync("npx", ["wrangler", "secret", "list"], { encoding: "utf8", shell: process.platform === "win32" });
  if (res.status !== 0 || !res.stdout) return null; // 未ログイン等では判定できない
  const names = [];
  const re = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(res.stdout)) !== null) names.push(m[1]);
  return names;
}

// ---------------------------------------------------------------------------
// Worker本体(src/utils/crypto.ts)と同一のパスワードハッシュ
// ---------------------------------------------------------------------------

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashPassword(password, pepper, iterations) {
  // Workerは `${pepper}:${password}` をキーマテリアルにする仕様
  const salt = new Uint8Array(16);
  getRandomValues(salt);
  const keyMaterial = await subtle.importKey("raw", new TextEncoder().encode(`${pepper}:${password}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, keyMaterial, 256);
  return { hash: toBase64Url(new Uint8Array(bits)), salt: toBase64Url(salt), iterations };
}

function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== cf-bbs 管理者アカウント作成 ===");
  console.log("対象: " + (flagLocal ? "ローカルD1 (--local)" : "本番D1 (--remote)"));
  console.log("");

  const email = (argEmail ?? (await askVisible("管理者のメールアドレス（半角）: "))).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("エラー: メールアドレスの形式が不正です");
    process.exit(1);
  }

  const username = (argUsername ?? (await askVisible("表示用ユーザー名（任意・空欄OK）: "))).trim();

  if (argPassword === undefined && !process.stdin.isTTY) {
    console.error("エラー: 対話的に実行するか --password を指定してください（標準入力がTTYではありません）");
    process.exit(1);
  }
  const password = argPassword ?? (await askHidden("パスワード（8文字以上・入力内容は表示されません）: "));
  if (password.length < 8 || !/^[\x20-\x7E]+$/.test(password)) {
    console.error("エラー: パスワードは8文字以上の半角文字にしてください");
    process.exit(1);
  }

  // PEPPERの決定: 引数 > .dev.vars > 対話入力（シークレット未設定なら空でOK）
  let pepper = argPepper;
  let pepperNote = "";
  if (pepper === undefined) {
    const names = listSecretNames();
    const fromVars = readPepperFromDevVars();
    if (names && !names.includes("PASSWORD_PEPPER")) {
      pepper = "undefined";
      pepperNote = "PASSWORD_PEPPERシークレットが未設定のため、Worker側の実挙動に合わせ pepper='undefined' として計算しました。";
    } else if (fromVars !== null && !flagLocal) {
      pepper = fromVars;
      pepperNote = ".dev.vars の PASSWORD_PEPPER を使用しました（本番と同じ値であることを確認してください）。";
    } else {
      pepper = await askHidden("PASSWORD_PEPPER（wrangler secret put PASSWORD_PEPPER で設定した値・未設定なら空欄）: ");
      if (pepper === "" && !process.stdin.isTTY) {
        pepper = "undefined";
        pepperNote = "標準入力がTTYでないため、PEPPER未設定(undefined)扱いで計算しました。";
      }
    }
  }
  // 空入力時にWorkerの実挙動（未設定 → 文字列"undefined"が混ざる）へ合わせる
  if (pepper === "") pepper = "undefined";

  const { hash, salt, iterations } = await hashPassword(password, pepper, argIterations);
  const userId = toBase64Url(getRandomValues(new Uint8Array(16)));
  const now = Date.now();

  const sql = [
    `INSERT INTO users (user_id, email, username, password_hash, password_salt, password_iterations, role, tier, status, ban_reason, created_at, updated_at)`,
    `VALUES ('${sqlEscape(userId)}', '${sqlEscape(email)}', ${username ? `'${sqlEscape(username)}'` : "NULL"}, '${sqlEscape(hash)}', '${sqlEscape(salt)}', ${iterations}, 'admin', 'regular', 'active', NULL, ${now}, ${now})`,
    `ON CONFLICT(email) DO UPDATE SET`,
    `  password_hash = excluded.password_hash,`,
    `  password_salt = excluded.password_salt,`,
    `  password_iterations = excluded.password_iterations,`,
    `  role = 'admin',`,
    `  status = 'active',`,
    `  ban_reason = NULL,`,
    `  updated_at = excluded.updated_at;`,
  ].join(" ");

  console.log("");
  console.log("D1へ登録中...");
  const execArgs = [
    "wrangler",
    "d1",
    "execute",
    "DB_MAIN",
    flagLocal ? "--local" : "--remote",
    "-y",
    "--command",
    sql,
  ];
  const res = spawnSync("npx", execArgs, { stdio: "inherit", shell: process.platform === "win32" });

  if (res.status !== 0) {
    console.error("");
    console.error("エラー: wrangler d1 execute が失敗しました（Cloudflareへログインしているか確認してください）");
    process.exit(res.status ?? 1);
  }

  console.log("");
  console.log(`✔ 完了: ${email} を role='admin' で登録（または更新）しました`);
  if (pepperNote) console.log("ℹ " + pepperNote);
  console.log("");
  console.log("次のステップ:");
  console.log("  1. ブラウザで /login.html を開き、上で入力したメールアドレスとパスワードでログイン");
  console.log("     （既にログイン済みの場合は一度ログアウトしてから再ログインしてください）");
  console.log("  2. トップバーに「管理」リンクが表示されれば成功です（/admin.html）");
  console.log("");
  console.log("ログインできない場合は PASSWORD_PEPPER の値が本番と一致していません。");
  console.log("再度このスクリプトを実行し、正しいPEPPER（または空欄）を指定してください。");
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exit(1);
});
