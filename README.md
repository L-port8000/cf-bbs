# cf-bbs

[Normalサーバのセットアップガイド](https://github.com/L-port8000/cf-bbs/tree/normal)

[Incognitoサーバのセットアップガイド](https://github.com/L-port8000/cf-bbs/tree/incognito)


Cloudflare Workers + D1 + Turnstile + TypeScript + Wrangler で構築した、
**Cloudflare Free Plan での実運用を想定した BBS** です。個人〜小規模コミュニティ
での運用を主なターゲットにしています（理由は「既知の制約」を参照）。

**R2 と Durable Objects は使用していません。** R2はFree Planでも有効化時に
支払い設定への同意を求められる場合があり、Durable Objectsも環境によっては
デプロイ時に同様の確認を求められることがあるため、本プロジェクトでは
どちらも避け、**Workers + D1 + Cache API** のみで構成しています
（v2より認証をJWT/HMAC方式へ移行したため、**KVも使用していません**）。

このREADMEは長いですが、初回セットアップは次の「**サーバーの建て方（新規構築の通し手順）**」
を上から順に実行すれば完了します（各ステップの詳細は対応する章を参照）。
最後の「実装済み / 未実装 / 要追加設定 / 既知の制約」は必ず目を通してください。

---

## 0. 全体構成

```
public/                 フロントエンド（素のHTML/CSS/JS, ビルド不要）
scripts/
  setup.sh              2つ目以降のサーバーを1コマンドで構築するスクリプト
  create-admin.mjs      管理者をCLIからD1へ直接登録するスクリプト
  test-v10.sh ほか      ローカルエミュレーションテスト（wrangler devで実行・23章参照）。
                        test-v11-api-keys.mjs（外部ツール拒否+APIキー）・
                        test-v11-server-check.mjs（サーバー手動レスポンスチェック）を含む
src/
  index.ts              Worker エントリポイント（ルーティング・cron・日次アクセスカウンタ）
  routes/                auth.ts / posts.ts / admin.ts / servers.ts（複数サーバー） /
                          cluster.ts（サーバー間同期・日次ヘルスチェック） / status.ts（利用状況）
  middleware/             session.ts（JWT/HMAC両対応セッション） / csrf.ts / rateLimit.ts / auth.ts
  db/                     queries.ts（D1クエリ） / sharding.ts（シャード・保持期限管理）
  utils/                  crypto.ts / escape.ts / segmenter.ts / settings.ts /
                          cache.ts（公開データキャッシュ） / cacheCounter.ts（Rate Limit・日次カウンタ） /
                          dosGuard.ts（新規エンドポイント用DoS対策） / turnstile.ts / response.ts /
                          jwt.ts（HS256署名検証） / clusterSync.ts（サーバー間HMAC署名通信）
migrations/
  main/0001_init.sql      DB_MAIN 用スキーマ
  main/0002_add_features.sql  ユーザー名・known_servers・関連設定の追加
  main/0003_username_daily_limit.sql ユーザー名変更の1日回数制限用（カウンタテーブル・設定移行）
  main/0004_server_types_and_password_limit.sql サーバー種別・パスワード最大長
  main/0005_server_health.sql サーバー稼働状態・日次アクセス統計・d1_sessions（HMACモード用）
  main/0006_registration_ip_and_server_removal.sql 登録IP保持（既定OFF）・サーバー自動削除用連続到達不能日数
  main/0007_session_invalidation.sql パスワード変更時のセッション即時失効（JWTモード対応・v10.1）
  main/0008_api_keys.sql APIキー（外部ツール用の正規認証経路・v11）
  main/0009_admin_daily_quota.sql 管理者向け1日回数制限カウンタ（サーバー手動チェック・v11.2）
  shard/0001_init.sql     DB_SHARD_1 / DB_SHARD_2 用スキーマ（共通）
  shard/0002_add_username.sql シャード側threads/postsへのユーザー名カラム追加
wrangler.toml             Bindings・Cron設定（3本: 23:59/0:00/0:01 JST）
```

D1データベースは3つ（DB_MAIN / DB_SHARD_1 / DB_SHARD_2）を基本構成とし、KVは
v2から使用停止（JWT/HMAC認証へ移行、消費ゼロ）です。
R2・Durable Objectsは使用しません。

---

## サーバーの建て方（新規構築の通し手順）

新しいサーバーを1台、ゼロから建てる手順を上から順にまとめたものです。
各ステップの詳細（背景・オプション・失敗時の対処）は対応する章を参照してください。

前提: Cloudflareアカウント作成済み / Node.js 18以上 / `npx wrangler login` 実行済み（§1）。

### 手順1: プロジェクトの準備

```bash
cd cf-bbs2        # wrangler.toml と package.json が見える階層まで移動する（重要: §17 参照）
npm install
```

### 手順2: D1を3つ作成（詳細: §2）

```bash
npx wrangler d1 create cf-bbs-main
npx wrangler d1 create cf-bbs-shard1
npx wrangler d1 create cf-bbs-shard2
```

各コマンドの出力に `database_id` が表示されるので、**3つともメモ**する。

### 手順3: KVを作成（詳細: §3）

```bash
npx wrangler kv namespace create SESSIONS_KV
```

表示された `id` をメモする。v2でKVは使用停止（消費ゼロ）だが、緊急ロールバック用に
バインディングだけ残置するため作成が必要。

### 手順4: wrangler.toml にIDを割り当てる

同梱の `wrangler.toml` には `REPLACE-WITH-*` というプレースホルダーが入っています
（`REPLACE-WITH-DB-MAIN-ID` / `REPLACE-WITH-DB-SHARD1-ID` / `REPLACE-WITH-DB-SHARD2-ID` /
`REPLACE-WITH-KV-NAMESPACE-ID` の4種類）。メモした4つのIDへ置き換えます。
IDの記載箇所は `[[d1_databases]]` の `database_id` ×3、`[[kv_namespaces]]` の `id` ×1、
`[vars]` の `DB_MAIN_ID` / `DB_SHARD_1_ID` / `DB_SHARD_2_ID` / `SESSIONS_KV_ID`
（/status機能用・任意だが後から忘れやすいのでここで一緒に書く）の**計8箇所**。
`scripts/setup.sh` を使う場合はこの手順は自動で行われます（置換漏れもチェックされます）。

```bash
# 置き換え対象の箇所を一覧する（8箇所ヒットすればOK）
grep -n 'REPLACE-WITH-' wrangler.toml

# プレースホルダー → 実際のID へ置換（各プレースホルダーはtoml内に2箇所ずつ
# あるため、必ず /g を付けて両方同時に置き換える）
sed -i 's/REPLACE-WITH-DB-MAIN-ID/メモしたMainのID/g' wrangler.toml
sed -i 's/REPLACE-WITH-DB-SHARD1-ID/メモしたshard1のID/g' wrangler.toml
sed -i 's/REPLACE-WITH-DB-SHARD2-ID/メモしたshard2のID/g' wrangler.toml
sed -i 's/REPLACE-WITH-KV-NAMESPACE-ID/メモしたKVのID/g' wrangler.toml

# 置換漏れチェック（何も出力されなければOK）
grep -n 'REPLACE-WITH-' wrangler.toml
```

置換漏れがあると dry-run は通ってもマイグレーションや /status が別のDBを
見に行くため、必ず最後にもう一度 grep して残りが無いことを確認する。
検証: `npx wrangler deploy --dry-run` がエラー無く通ればOK。
Worker名（`name`）や `SERVER_DISPLAY_NAME` / `PRIMARY_API_DOMAIN`
（自分のサーバーの実URLに変更）は必要に応じて変更する（§11 / §14 参照）。

### 手順5: マイグレーション（冪等・何度実行しても安全）

```bash
npm run db:migrate:remote          # DB_MAIN（0001〜0009を適用）
npm run db:migrate:shard1:remote   # DB_SHARD_1
npm run db:migrate:shard2:remote   # DB_SHARD_2
```

### 手順6: シークレット6種を設定（詳細: §5）

最初にランダム値生成関数を定義しておく（SYNC_SECRET はサーバー間で共有する値のため、Backup構成にする場合はメモして再利用する。§11 参照）:

```bash
gen_secret() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }

# （1）PASSWORD_PEPPER —— 生成した値を必ずメモしてから設定する
gen_secret   # ← 表示された値をメモする
echo "メモした値" | npx wrangler secret put PASSWORD_PEPPER

# （2）残りの4つはランダム生成をそのまま流し込んでOK（メモ不要）
gen_secret | npx wrangler secret put SESSION_HMAC_SECRET
gen_secret | npx wrangler secret put CSRF_HMAC_SECRET
gen_secret | npx wrangler secret put SYNC_SECRET
gen_secret | npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN

# （3）Turnstile は暫定でテスト用シークレットを入れる（手順9で実キーへ差し替え）
echo "1x0000000000000000000000000000000AA" | npx wrangler secret put TURNSTILE_SECRET_KEY
```

> ⚠️ **PASSWORD_PEPPER は自分で決めた値を必ずメモしておくこと。**
> ランダム生成してそのままパイプで投入し、値をどこにも残さなかった場合、
> その pepper で作ったアカウントのパスワード照合が不可能になる
> （実際に起きた失敗例。復旧には pepper 再設定＋DB再作成が必要になる）。

### 手順7: デプロイ（詳細: §8）

```bash
npx wrangler deploy
```

`https://<name>.<サブドメイン>.workers.dev` にアクセスしてトップページが
表示されることを確認する。Cron（死活監視3本: 23:59/0:00/0:01 JST）は
wrangler.toml に同梱済みのため変更不要。

### 手順8: 最初の管理者を作る（詳細: §18）

```bash
node scripts/create-admin.mjs \
  --email 'admin@example.com' \
  --password '半角8文字以上' \
  --username 'admin' \
  --pepper '手順6でメモしたPASSWORD_PEPPERの値'
```

`--pepper` を付けると PASSWORD_PEPPER の対話入力自体がスキップされる。
登録後、**ログインし直す**とトップバーに「管理」リンクが出る。
pepper の値を失念してしまった場合は create-admin.mjs は使えないため、
§18 の方法B（`BOOTSTRAP_ADMIN_EMAIL` を設定してデプロイ→そのメールで登録）か
方法C（/register.html で一般登録 → D1で role を admin に更新）を使う。
どちらも pepper を知らなくて管理者を作れる。

### 手順9: Turnstile を実キーへ差し替える（本番運用時・詳細: §4）

初期状態はテストキー（常に成功するダミー）で稼働している。本番運用前に
Turnstileダッシュボードでウィジェットを作成し、
(1) wrangler.toml の `TURNSTILE_SITE_KEY` を実際の Site Key に書き換え、
(2) 実際の Secret Key を `echo "実Secret" | npx wrangler secret put TURNSTILE_SECRET_KEY` で設定、
(3) `npx wrangler deploy` で再デプロイする。

### 手順10: 動作確認チェックリスト

- `GET /api/public-config` が 200 を返す
- トップページ表示・スレッド作成・返信ができる
- 手順8の管理者でログインするとトップバーに「管理」リンクが出る
- /settings.html に「メールアドレス変更」「パスワード変更」「アカウントを削除」のカードがある
- （[vars] の /status 設定済みなら）/status.html に利用状況が出る

### 2台目以降を建てる場合

§14「2つ目以降のサーバーを簡単に建てる」を参照。`scripts/setup.sh` が
D1/KV作成〜シークレット設定までを自動化するが、**PASSWORD_PEPPER はランダム生成されて
そのまま投入される（どこにも記録されない）**点に注意。setup.sh を使った直後は
ユーザーがまだ存在しないため、已知の値で pepper を設定し直すか、上記の手順8の
方法B/Cで管理者を作れば安全。既存サーバーの管理画面から新サーバーを登録すると、
全サーバーのリストが新サーバーへ即時配信される。

---

## 1. 事前準備

1. Cloudflareアカウントを作成し、[Node.js](https://nodejs.org/)（18以上推奨）をインストール
2. このプロジェクトのルートで依存関係をインストール

   ```bash
   npm install
   ```
3. Wranglerでログイン

   ```bash
   npx wrangler login
   ```

---

## 2. D1データベースの作成

Main用と、容量分散（シャーディング）用に2つ、計3つ作成します。
（いずれも通常のD1で、有効化にあたって追加の支払い設定は不要です。）

```bash
npx wrangler d1 create cf-bbs-main
npx wrangler d1 create cf-bbs-shard1
npx wrangler d1 create cf-bbs-shard2
```

それぞれのコマンドが出力する `database_id` を `wrangler.toml` の
`REPLACE-WITH-DB-MAIN-ID` / `REPLACE-WITH-DB-SHARD1-ID` / `REPLACE-WITH-DB-SHARD2-ID`
へ書き換えてください。

マイグレーションを適用します（`--local` はローカル開発用、本番投入前に `--remote` も実行）。

```bash
npm run db:migrate:local
npm run db:migrate:shard1:local
npm run db:migrate:shard2:local

npm run db:migrate:remote
npm run db:migrate:shard1:remote
npm run db:migrate:shard2:remote
```

---

## 3. KV Namespace の作成（v2で使用停止・必須ではなくなりました）

> **v2（JWT/HMAC認証）以降、KVは一切使用しません（消費ゼロ）。**
> 旧バージョンからの切り替え・緊急ロールバックに備えて `SESSIONS_KV` バインディングのみ
> 残置しています。新規セットアップの場合、この章の手順は**スキップして構いません**
> （`wrangler.toml` のKVブロックと `SESSIONS_KV_ID` を削除して deploy してください）。

```bash
npx wrangler kv namespace create SESSIONS_KV   # （KVを使う場合のみ）
```

> **参考**: Workers KV Free Planの書き込み上限は **1,000回/日（アカウント全体で共有）**。
> 旧実装はKVをセッション保存に使っていたため、この上限が「1日の新規ログイン数」の
> 天井になっていました。v2では認証をJWT / HMAC（D1セッション）に移行したため
> KV制約は完全に消えました（詳細は「19. ストレージ別の用途と消費量」参照）。

---

## 4. Turnstile の設定

1. Cloudflareダッシュボード → Turnstile → 「Add site」でウィジェットを作成
2. デプロイ先ドメイン（Primary/Backup両方）を登録
3. 発行された **Site Key** を `wrangler.toml` の `TURNSTILE_SITE_KEY` に設定
4. 発行された **Secret Key** をシークレットとして設定（後述）

ローカル開発時は、Cloudflareが公式に提供している「常に成功するテスト用キー」
(`1x00000000000000000000AA` / secret `1x0000000000000000000000000000000AA`) を
利用できます（本番では必ず実際のキーに差し替えてください）。

### Turnstileの仕様と本実装の注意点（v6で修正）

- Turnstileのトークンは**1回のsiteverify検証で消費される**ため、送信が何らかの
  理由で失敗した後に同じトークンで再送すると `timeout-or-duplicate`（使用済み）
  になり必ず失敗します。そこでフロントエンドは、送信が失敗するたび（投稿の成功後も）
  ウィジェットを自動リセットして新しいトークンを取得します。ユーザーはエラー画面で
  「もう一度」押すだけでリトライできます。
- トークンには約5分の有効期限があります。フォームを開いたまま放置した場合も
  `refresh-expired: auto` によりウィジェットが自動で再発行します。
- サーバー（`/api/auth/register`, `/api/auth/login`, 投稿系API）はsiteverifyの
  エラーコードに応じた日本語メッセージを返します（期限切れ/使用済み・未取得・
  シークレット設定不備などを区別）。
- `/api/public-config` は `turnstileOnAuth` / `turnstileOnPost` フラグを返し、
  フロントエンドはトークン未取得のまま確実に失敗する送信を事前に防ぎます。
- 管理画面の「投稿時にTurnstileを要求する」は v6 からスレッド作成・返信の両APIで
  実際に強制されます（従来は設定UIがあるだけでサーバー側では効いていませんでした）。

> **重要（稼働中サイトの設定確認）**: 配布直後の `wrangler.toml` にはテスト用
> Site Key (`1x000...AA`) が入っています。このまま本番運用するとTurnstileは
> **ボット対策として機能していません**（誰でもスクリプトから登録・投稿が可能）。
> 本番用には §4 の手順で実際のSite Key / Secret Keyへ差し替えてください
> （Site Keyは `wrangler.toml` を変更して再デプロイ、Secret Keyは
> `npx wrangler secret put TURNSTILE_SECRET_KEY` で更新します）。

---

## 5. シークレットの設定

以下はすべて `wrangler secret put <NAME>` で設定します（`wrangler.toml` には書きません）。

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put SESSION_HMAC_SECRET
npx wrangler secret put CSRF_HMAC_SECRET
npx wrangler secret put SYNC_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
```

| シークレット | 用途 |
|---|---|
| `TURNSTILE_SECRET_KEY` | Turnstile siteverify検証用 |
| `PASSWORD_PEPPER` | PBKDF2パスワードハッシュに連結するアプリ全体共有の秘密値（32文字以上のランダム文字列を推奨） |
| `SESSION_HMAC_SECRET` | （将来の拡張用に予約。現行実装では未使用だが破壊的変更を避けるため残置） |
| `CSRF_HMAC_SECRET` | CSRFトークンの署名鍵 |
| `SYNC_SECRET` | Primary/Backup間のリコンサイルAPI認証用共有シークレット |
| `ADMIN_BOOTSTRAP_TOKEN` | （現行実装では `BOOTSTRAP_ADMIN_EMAIL` 方式を採用しているため未使用。将来トークン方式に切り替える場合用に予約） |

ローカル開発では、`.dev.vars.example` を `.dev.vars` にコピーして値を埋めてください
（`.dev.vars` はGit管理外です）。

---

## 6. wrangler.toml の編集

`wrangler.toml` の `[vars]` セクションを実際の値に書き換えてください。

```toml
[vars]
ENVIRONMENT = "production"
DEPLOYMENT_ROLE = "primary"          # Backup側でデプロイする場合は "backup"
PRIMARY_API_DOMAIN = "bbs.example.com"
BACKUP_API_DOMAIN = "bbs-backup.example.com"
COOKIE_DOMAIN = ""                    # 10章参照。基本は空文字のままでよい
TURNSTILE_SITE_KEY = "実際のSite Key"
BOOTSTRAP_ADMIN_EMAIL = "you@example.com"   # 初回デプロイ後の最初の管理者
```

`ENVIRONMENT` は `"production"` にすると、`PRIMARY_API_DOMAIN` /
`BACKUP_API_DOMAIN` 以外のHostヘッダでのアクセスを拒否する
（Host Header Injection対策）ようになります。ローカル開発中や動作確認中は
`"development"` にするか、`*.workers.dev` のプレビューURLを使ってください
（`*.workers.dev` は常に許可されます）。

---

## 7. Custom Domain の設定

Cloudflareダッシュボード → Workers & Pages → 対象Worker → Settings → Domains & Routes
から、`PRIMARY_API_DOMAIN` に設定したドメインを Custom Domain として追加してください
（Workers Free Planでも Custom Domain 自体は利用可能です）。

---

## 8. デプロイ

```bash
npm run typecheck
npm run deploy
```

初回デプロイ後、`BOOTSTRAP_ADMIN_EMAIL` に設定したメールアドレスで新規登録すると、
そのアカウントが自動的に管理者（role='admin'）になります。管理者が1人できたら、
`BOOTSTRAP_ADMIN_EMAIL` を空文字に戻して再デプロイすることを推奨します
（第三者が同じメールアドレスで登録して管理者権限を得ることを防ぐため）。

---

## 9. 管理者設定

`/admin.html` にログイン後アクセスすると、以下が行えます。

- ユーザー検索・BAN/BAN解除・管理者への昇格
- 投稿・スレッドの非表示/削除
- 設定変更（1日投稿数上限・投稿間隔・最大文字数・URL数上限・Turnstile要求有無・
  データ保持期間など。すべて `admin_settings` テーブルに保存され、
  ハードコードされていません）
- D1シャード移行のバッチ実行（`main→shard1`、`shard1→shard2`）
- 保持期間を超えたデータの完全削除（`shard1`/`shard2` が対象。詳細は次章）
- 監査ログの閲覧

---

## 10. D1容量分散とデータの自動削除（R2不使用・使用DB数は管理画面から選択）

古いスレッドは `Main → Shard1 → Shard2` の順にスレッド単位で移行されます。
**R2は使わない**ため、Shard2の容量がさらに逼迫した場合は、これ以上移行先を
増やす代わりに、管理設定の `data_retention_days`（既定730日）を超えたスレッドを
保持期間超過のDBから**完全に削除**して容量を確保します（`POST /api/admin/purge-expired`、
管理画面の「シャード移行」タブから実行可能。Cron Triggerでも毎日自動実行されます）。

- 移行・削除ともにスレッド単位で行われ、1スレッド内の投稿を日付等で
  さらに分割することはしません。
- 削除は元に戻せません。保持期間は運用ポリシーに応じて `/admin.html` から
  変更してください。
- どのスレッドがどのD1にあるかは `DB_MAIN` の `archive_manifest` テーブルが
  管理し、スレッド一覧の取得は常に `DB_MAIN` のみを検索します（個別スレッド
  へのアクセス時のみ manifest を引いて対象D1へルーティングし、全D1を
  無条件に検索することはありません）。

### 使用するD1の数（db_shard_count・v2新設）

管理画面「設定」タブの「認証方式・データベース」で **使用するD1の数（1〜3）** を
選択できます。この値に応じて日次メンテナンス（23:59 JSTのcron）の挙動が変わります:

| 設定 | 移行チェーン | 保持期間超過データの削除先 |
|------|-------------|--------------------------|
| 1 | 移行なし（全データをDB_MAINに置き続ける） | DB_MAIN から直接削除 |
| 2 | main → shard1（180日経過分） | shard1 から削除 |
| 3 | main → shard1 → shard2（180日/365日経過分） | shard2 から削除（従来動作） |

- 設定を下げても既に移行済みのデータは自動では戻りません（manifest経由で
  引き続き閲覧可能です）。
- 作成したD1が1つだけなら「1」を、2つなら「2」を設定してください。
  未作成のD1へのバインディングが残っていても、設定した数以上のDBは
  読み書きされません。

---

## 11. Primary / Backup API ドメインについて（重要）

`PRIMARY_API_DOMAIN` / `BACKUP_API_DOMAIN` は2つの異なる目的に使えますが、
**「単純にドメインを2つ用意すればCloudflareの制限を回避できる」わけではありません**。
現在のCloudflare Free Planの制限（Workers 100,000リクエスト/日など）はアカウント単位で
かかるため、以下のどちらの構成を取るかで意味が変わります。

### 構成A: 同一アカウント・同一Workerに2つのCustom Domainを割り当てる

- 用途: DNS障害やネットワーク経路の問題に対するフェイルオーバー**のみ**。
- **リクエスト数上限やD1/KVの上限はアカウント単位で共有されるため、
  実質的な処理能力の分散にはならない**（「単純なドメイン変更だけで
  制限を回避できるとは仮定しない」という要求仕様に対応）。
- `COOKIE_DOMAIN` に両ドメインの共通の親ドメイン（例: `.example.com`。
  両ドメインがそのサブドメインである必要がある）を設定すると、
  セッションCookieが両ドメイン間で共有され、フロントエンドの自動フェイルオーバー
  （`public/common.js` の `apiFetch`）がログイン状態を保ったまま機能します。

### 構成B: 別のCloudflareアカウント・別Workerプロジェクトとしてデプロイする

- 用途: 本当の意味でのリクエスト数・D1/KV容量の分散。
- 2つ目のプロジェクトとして、このリポジトリ一式を**別アカウントに対して**
  `DEPLOYMENT_ROLE = "backup"` でデプロイし、独自のD1/KVを持たせます。
- この構成では**データが自動的には同期されません**（別アカウント＝別D1のため）。
  Backup経由で投稿されたスレッド/投稿には `origin = 'backup'` が記録されます。
- Primary復旧後、管理者が `POST /api/admin/sync/pull-from-backup` を
  （`X-Sync-Secret` ヘッダに `SYNC_SECRET` を付けて）呼び出すことで、
  Backup側に溜まったデータをPrimaryへ手動で取り込めます（本実装では
  自動化されていません。取り込み対象データをBackup側で抽出してPOSTする
  スクリプトは含まれていないため、必要に応じて別途実装してください）。
- Cookieは異なる登録可能ドメイン間では共有できないため、Backupへ切り替わった
  利用者は改めてBackup側でログインする必要があります。

どちらの構成でも、Cookieに `Domain` 属性を不用意に広く設定しないよう
`COOKIE_DOMAIN` は既定で空文字（＝現在のホストのみ）にしています。

---

## 12. セキュリティ上の注意

- パスワードは PBKDF2-SHA256（既定10万回）+ アプリ共有ペッパーでハッシュ化。
  平文は一切保存しません。Argon2idは採用していません（CPU時間制限とのトレードオフ。
  「既知の制約」参照）。
- セッションIDはCryptographically secureな乱数、CookieはHttpOnly / Secure /
  SameSite=Lax。ログインごとにSession IDを再生成（Session Fixation対策）。
- CSRFはSession IDにHMAC署名した値をDouble Submit Cookieとして使う、
  ステートレスな「Session紐付けToken」方式。
- Rate Limit（投稿間隔・1日上限・ログイン試行のブルートフォース対策）は
  KVでもDurable Objectsでもなく **Cache API**（`src/utils/cacheCounter.ts`）で
  実装しています。KVの書き込み枠（1,000回/日）を消費せず、Free Planで
  追加の支払い設定なしに動作しますが、データセンター単位の緩い一貫性しか
  持たない「ソフトな」制限になります（詳細は「既知の制約」参照）。
- 投稿本文は常にプレーンテキストとして保存し、フロントエンドは `textContent` /
  `createElement` のみでDOMへ挿入します（`innerHTML` へユーザー入力を渡さない）。
  サーバー側にもHTMLエスケープ関数(`src/utils/escape.ts`)を用意していますが、
  現行のJSON APIレスポンスでは未使用です（将来SSRするページを追加する場合に使用）。
- SQLインジェクション対策として、全D1クエリはプレースホルダ(`?`)を使用しています
  （文字列連結によるSQL構築は一切行っていません）。
- 管理者権限・投稿権限・アカウント状態など、クライアントが送ってくる値は
  一切信用せず、常にサーバー側の値（JWT署名/HMAC署名の検証結果、およびD1上の
  サーバー側の値）のみで判定します。

---

## 13. ユーザー名機能

登録時に任意でユーザー名を設定できます（未設定なら投稿時に「名無しさん」と
表示されます）。ログイン後は `/settings.html` からいつでも変更できます
（乱用防止のため、**1日あたりの変更回数上限（既定5回/日）**が設けられています。
カウントは UTC 日付ベースで、成功した変更のみを消費します。上限値は
`username_daily_change_limit` として管理画面の「設定」タブから変更可能です）。

投稿・スレッドの表示名は、投稿された**その時点の**ユーザー名をコピーして
D1へ保存します（`posts.username` / `threads.username`）。理由は、投稿は
シャードごとに別々のD1データベースへ分散されるため、`users`テーブル
（DB_MAINのみに存在）とシャード側のD1をまたいだJOINができないためです。
したがって、**ユーザー名を変更しても過去の投稿の表示名は変わりません**
（BBSでよくある「投稿時点の名前が残る」挙動です）。

文字数制限・使用可能文字・1日あたりの変更回数上限は `admin_settings`（管理画面の
「設定」タブ）から変更できます。

---

## 14. 複数サーバー選択機能（板のトップに統合）

複数の独立したcf-bbsデプロイ（＝別々のCloudflareアカウント上の別Worker、
それぞれが独自のD1を持つ）を、`/index.html`（板のトップ）から直接切り替えて
閲覧できる機能です。日々の閲覧は板の画面上部の横スクロール切り替えチップで
行い、全サーバーの一覧・検索は `/servers.html`（サーバ一覧ページ・v11新設）に
分離しています。**各サーバーの掲示板の内容は独立しており、同じ内容が表示されると
は限りません**（要求どおりの仕様です）。これにより、1アカウント・1Workerが抱える
Free Planのリクエスト数・D1容量の上限を、複数アカウントに処理を分散することで
実質的に緩和できます。

### 仕組み

- 各サーバーはDB_MAINに `known_servers`（url, name）という「既知サーバー一覧」を
  持ちます。`GET /api/servers` はこれを公開レスポンスとして返します。
- `/index.html` を開くと、まず自分の板が表示され、既知サーバーがあれば
  上部にチップとして並びます。他サーバーのチップを押すと、そのサーバーの
  `/api/threads` をブラウザから直接（クロスオリジンで）取得し、板の内容を
  その場で読み込んで表示します（ページ遷移しません）。
- リモートサーバーの表示は**読み取り専用**です。Cookie（ログインセッション）は
  ドメインごとに別々のため、他サーバーへ投稿するには実際にそのサーバーへ
  アクセスしてログインする必要があります。スレッド一覧・投稿一覧には
  「◯◯で投稿する」という直接アクセス用のリンクを表示します。
- クロスオリジンでの閲覧を可能にするため、`GET /api/public-config` /
  `GET /api/servers` / `GET /api/threads` / `GET /api/threads/:id/posts`
  の4つの**読み取り専用**エンドポイントのみ、どのオリジンからでもアクセス
  できるようCORSを開放しています（`Access-Control-Allow-Origin: *`。
  Cookie等の認証情報は一切伴わないため、閲覧されても実害はありません）。
  それ以外の状態変更API・認証情報を含むAPIは、従来どおり許可された
  ドメインのみに制限されています。
- 管理画面「サーバー管理」タブから、別サーバーのURLを**追加**できます
  （追加時にそのURLへ`GET /api/public-config`を叩いて、本当にcf-bbsサーバーが
  応答するかを簡易確認します）。**応答を確認できた場合のみ登録され、
  その時点で「稼働中」バッジ付きで一覧に載ります**（v11.2）。追加すると、
  既知の全サーバーへ1回だけ「こんなサーバーがあるよ」と知らせ（announce）、
  同時に相手にも自分を知らせます（相互登録）。
- 管理画面「サーバー管理」タブの**「チェック」ボタン**（v11.2）で、登録済みの
  任意のサーバーへの応答をその場で手動確認できます。応答があれば「稼働中」へ更新
  （一時的なエラーで「応答なし」だったサーバーの復旧・連続到達不能日数のリセット）。
  応答がなければ「応答なし」へ更新します。1管理者あたり1日10回まで
  （日本時間の0時にリセット・0009）。判定基準は日次cronの自動チェックと完全に同じ
  （`GET /api/health`）。詳細は25章参照。
- announceは受信しても**さらに転送しません**（無限ループ防止のため、
  意図的に1ホップのみに制限しています）。
- 管理画面から「このサーバーから一覧を取り込む」（sync-pull）を実行すると、
  指定したURLの`/api/servers`を取得し、自分のD1へマージします。
- `/api/servers` と `/api/servers/announce` には、BBS本体とは別枠の
  IPベースの短時間DoS対策（`src/utils/dosGuard.ts`）を適用しています
  （要望どおり、BBSの投稿・閲覧APIには一切影響しません）。

### サーバ一覧ページとお気に入り（v11新設）

板トップのチップ列は、**お気に入り（★）が1件でもあるときは「自分＋お気に入り」
だけ**を表示し、1件も無いときは従来どおり全既知サーバーを「おすすめサーバー」と
して表示します（ラベルでどちらの状態か分かります）。

- **サーバ一覧ページ（`/servers.html`）**: 板トップの「サーバ一覧へ →」チップから
  移動できます。既知の全サーバーを一覧表示し、**名前・URLでの検索**（入力するたびに
  絞り込み）、各サーバーの★お気に入りトグル、稼働状態バッジ、「開く」（板へ移動）が
  できます。並び順は「自分 → お気に入り → その他」です。
- **お気に入り（★）**: サーバ一覧ページと設定ページのサーバー行で付/外せます。
  保存先は**端末（ブラウザ）ごとのlocalStorage**で、サーバー側へは送信・保存されません
  （キー: `bbs-favorite-servers`）。そのため端末間で共有されず、ログイン不要・
  ストレージ消費もゼロです。削除済みサーバーのURLが残っていても表示側で無視される
  ため害はありません。
- お気に入り登録は自分のサーバー（`self`）を対象外とします（常に板トップに表示される
  ため）。

### 日次ヘルスチェックとサーバー情報の自動共有（v2新設）

サーバー登録時の即時announceに加えて、毎日決められた時刻（日本時間）に
サーバー群が協調して**ダウン確認と情報共有**を行います（Cron Trigger・3本。
src/routes/cluster.ts 参照）:

| 時刻 (JST) | 動作 |
|-----------|------|
| 23:59 | 各サーバーが自分の**当日のアクセス数**を全既知サーバーへ共有（HMAC署名付き）。Cache APIのみで計測しKV/D1は消費しない |
| 0:00 | **前日のアクセスが少なかった順**に選ばれた最大3サーバー（総サーバー数が3以下なら全サーバー）が担当となり、全サーバーの `GET /api/health` を実行して生存確認 |
| 0:01 | 担当サーバーがチェック結果（稼働中/応答なし）を全サーバーへ**公開（push）**。非担当サーバーは担当サーバーから結果を**取得（pull）**して自分のDBを更新 |

- **0:00までにアクセス統計を転送してこなかったサーバーは担当に選ばれません**
  （レート制限等の可能性があるため。統計の共有自体が生きているかの確認を兼ねる）。
- 統計が一切共有されなかった初日に限り、各サーバーが自分自身を担当として
  チェックします（フォールバック）。
- チェック結果は `known_servers` の `health`（up/down/unknown）・`last_health_at`・
  `last_up_at` に保存され、設定ページのサーバー一覧に「稼働中 / 応答なし / 未確認」
  バッジとして表示されます（downでも「開く」は可能。誤検知に備えた仕様です）。
- サーバー間API（`/api/sync/*`）はすべて **SYNC_SECRET によるHMAC署名**で認証します
  （タイムスタンプ付きでリプレイを緩和・±5分の受付窓）。`SYNC_SECRET` は
  全参加サーバーで同じ値を `wrangler secret put` してください。
- 新規サーバーの登録は JWT/HMAC（KVを使わない認証）で行われ、登録されたサーバーは
  **即時に**全既知サーバーへannounceされ、さらに新規サーバー自身へは
  「現時点で判明している全リスト」をブートストラップ配信します
  （新規サーバーは手動取り込みなしで一覧を即座に把握できます）。

### サーバーの自動削除伝播（v10新設）

日次ヘルスチェックの結果、**連続して到達不能が続いたサーバーを全サーバーの
既知リストから自動削除**します（誤削除防止の安全装置付き）:

- **多数決**: 0:01に担当の先頭サーバー（集約者）が他の担当サーバーのチェック結果を
  収集し、サーバーごとに判定します。**2台以上の担当がdown判定した日のみ**
  「到達不能」とカウントし、1台の報告だけでは日数を進めません
  （担当の誤報・出口障害でもリストが消えない安全装置）。
- **連続日数しきい値**: 連続到達不能日数が `server_auto_removal_days`
  （既定3日・管理画面「設定」タブで1〜7日変更可）に達したサーバーは、
  集約者のリストから削除され、全サーバーへ削除が伝播します
  （`POST /api/sync/server-removed`・HMAC署名必須。受信側も集約レポートの
  しきい値到達行を自発的に削除する二重安全網付き）。
- **表示**: しきい値未満の到達不能サーバーは設定ページ・管理画面に
  「応答なし(N日)」バッジで表示されます（N=連続到達不能日数）。
- **復旧時の再登録**: 削除されたサーバーが復活すれば、翌日以降の23:59の
  統計共有（announce）で自然に各サーバーのリストへ再登録されます。
- **注意**: 自動削除には「2台以上の担当からの報告」が必要なため、
  **総サーバー数2台の構成では自動削除は動作しません**（手動削除してください）。
  自分自身のサーバーは削除対象から常に除外されます。

### 2つ目以降のサーバーを簡単に建てる

手動セットアップ（1〜9章）を毎回繰り返す代わりに、`scripts/setup.sh` で
D1×3・KV×1の作成からwrangler.tomlへの反映、マイグレーション適用、
シークレット生成・設定までを一括で行えます。

```bash
npx wrangler login   # 新しいサーバーを建てたいCloudflareアカウントでログイン
bash scripts/setup.sh server2 "サーバー2" you@example.com
```

実行後に表示される案内に従い、Turnstileキーを本番用に差し替えて
`npx wrangler deploy` すれば完了です。詳細はスクリプト冒頭のコメント、
または `bash scripts/setup.sh` （引数無し）で表示されるヘルプを参照してください。

デプロイ後、既存サーバーの管理画面「サーバー管理」タブから新しいサーバーの
URLを追加すると、板のトップに両方のサーバーが選択肢として表示されます。

---

## 15. /status（利用状況表示、任意機能）

`/status.html`（ログイン済みユーザー全員が閲覧可能。管理者専用から変更）で、
D1のストレージ使用量、Workersの本日のリクエスト数、可能であればD1の
読み取り/書き込みクエリ数・KVの操作回数をFree Planの上限に対する概算
パーセンテージで表示します。**この機能は完全に任意で、設定しなくても
BBS本体の動作には一切影響しません。**

日次集計の区切りは **毎日0:03（日本時間）** です（0:00〜0:02の死活監視シーケンスの
通信を前日の統計に含めないため。Cache APIの日次カウンタTTLも同区切りで失効）。
D1/KVの利用量の表示はCloudflare基準（UTC 0:00＝日本時間9:00）でリセットされます。

### 必要な設定

1. Cloudflareダッシュボード → 「マイプロフィール」→「APIトークン」→
   「トークンを作成」で、以下の権限を持つAPIトークンを発行する。
   - アカウント → Account Analytics → 読み取り
   - アカウント → D1 → 読み取り
2. 発行されたトークンをシークレットとして設定する。

   ```bash
   npx wrangler secret put CF_API_TOKEN
   ```
3. `wrangler.toml` の以下の変数を実際の値に書き換える。

   ```toml
   CF_ACCOUNT_ID = "あなたのアカウントID"       # ダッシュボードのURLや `wrangler whoami` で確認可能
   WORKER_SCRIPT_NAME = "cf-bbs"                # 冒頭の name と同じ値
   DB_MAIN_ID = "..."                           # [[d1_databases]] のDB_MAINと同じdatabase_id
   DB_SHARD_1_ID = "..."                        # 同上（Shard1）
   DB_SHARD_2_ID = "..."                        # 同上（Shard2）
   SESSIONS_KV_ID = "..."                       # [[kv_namespaces]] のSESSIONS_KVと同じid
   ```
4. 再デプロイする。

`CF_API_TOKEN` / `CF_ACCOUNT_ID` が未設定の場合、`/status.html` は
エラーにせず「未設定です」という表示にとどめます。

`/api/admin/status` にはBBS本体とは別枠のDoS対策（3秒間隔）に加えて、
Cloudflareの集計APIを無駄に呼び出さないよう、結果を5分間 Cache API へ
キャッシュしています。

---

## 16. UI/UXについて

- **PC/スマホ両対応**: `.app-shell`は可変幅で、狭い画面ではタップ領域を
  44px以上確保し、iOSでの意図しない自動ズームを防ぐためinput/textareaは
  16px以上のフォントサイズにしています。横に長い管理者用テーブルは
  画面幅を超えると横スクロールに切り替わります。
- **ローディング表示**: スレッド一覧・投稿一覧の読み込み中はスケルトン
  （灰色のプレースホルダ）を表示します。投稿・返信・ログイン・登録・
  ユーザー名変更・管理操作のボタンは、処理中は必ずスピナー付きの
  「◯◯中...」表示に切り替わり、連打による二重送信を防ぎます
  （`public/common.js` の `setButtonLoading` / `clearButtonLoading`）。
- **管理画面「概要」タブ**: 管理画面を開くとまず「概要」タブが表示され、
  登録ユーザー数・BAN数・管理者数・公開スレッド数・既知サーバー数・
  直近24時間の管理操作数と、主要な設定値をひと目で確認できます。
  各カードをクリックすると関連するタブへ移動します。設定タブ自体も
  「投稿制限」「Turnstile」「ユーザー名」「データ保持」のセクションに
  分けて表示しています。

---

## 17. トラブルシューティング

### `npx wrangler deploy` が「Could not detect a directory containing static files (e.g. html, css and js) for the project」で失敗する

このエラーは、**`wrangler.toml` が置かれているプロジェクトのルートディレクトリ
以外で `npx wrangler deploy` を実行したときに発生します**（コードのバグではありません）。

このプロジェクトはZipを展開すると `cf-bbs2/` というフォルダの中に本体が入っています。
展開ツールが同名フォルダとの衝突を避けるために `cf-bbs2-2` など別名の外側フォルダを
作った場合、実際のプロジェクトは **さらに1つ下の階層** にあります。
間違った階層で実行すると、wrangler は `wrangler.toml` / `package.json` を
見つけられず、静的サイトの自動検出（autoconfig）へフォールバックし、
静的ファイルディレクトリも見つけられずにこのエラーになります
（デバッグログには `configFileType: "none"` と
`No package.json found when running autoconfig` が記録されます）。

対処手順:

```bash
# 1. wrangler.toml がある階層まで移動する（ls で確認しながら）
cd ~/ダウンロード/Cloudflare/cf-bbs2-2
ls                       # → cf-bbs2/ だけが見える場合は、まだ1階層浅い
cd cf-bbs2
ls                       # → wrangler.toml と package.json が見えれば正しい場所

# 2. 依存関係をインストール（Zipには node_modules は含まれていないため）
npm install

# 3. デプロイ
npx wrangler deploy
```

ポイント: **`ls` で `wrangler.toml` と `package.json` が表示されるディレクトリが、
`deploy` / `d1 migrations apply` などすべての wrangler コマンドを実行すべき場所**です。
Zipを再展開するときは、展開後のフォルダ名が `cf-bbs2` 単体になるようにすると
間違えにくくなります。

### 投稿・新規登録で「内部エラーが発生しました」と表示される

閲覧（スレッド一覧・投稿一覧の表示）はできるのに、投稿・新規登録・
サーバー一覧（`GET /api/servers`）だけが「内部エラー」で失敗する場合、
**本番D1へ `0002_*` マイグレーションが適用されていない**のが原因です。

旧バージョン（または0001のみ適用済み）のD1に対して本バージョンをデプロイすると、
新コードが参照する `username` カラム（threads / posts / users）や
`known_servers` テーブルが存在せず、書き込み系APIだけが500エラーになります
（閲覧系は `SELECT *` のため列が足りなくてもエラーにならないので、
「閲覧はできるのに投稿だけ壊れる」という症状に見えます）。

確認方法（任意）:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<あなたのworker URL>/api/servers
# → 500 が返ってきたら本項目の該当確定
```

対処手順（プロジェクトのルートで実行。データは失われません — 0002は
列追加・テーブル追加のみで既存行には `'名無しさん'` が入ります）:

```bash
npm run db:migrate:remote         # DB_MAIN: 0002_add_features.sql を適用
npm run db:migrate:shard1:remote  # DB_SHARD_1: 0002_add_username.sql を適用
npm run db:migrate:shard2:remote  # DB_SHARD_2: 0002_add_username.sql を適用
```

`wrangler d1 migrations apply` は未適用のマイグレーションのみを自動検出して
適用するため、何度実行しても安全です。**スキーマ変更のみなので再デプロイは不要**です。
実行後、掲示板への投稿・新規登録・`/api/servers` が正常に動くようになります。

補足: `wrangler.toml` の書き換え（sed等）は不要です。database_id などが
実際の値に置き換え済みであれば、設定ファイルはこのままで正しく動作します。

### 投稿はできるが `GET /api/servers` だけ 500 エラーになる（旧バージョンが稼働している）

「閲覧も投稿も問題なくできるのに、`/api/servers` だけが 500」の場合、
**稼働しているWorkerのコードが旧バージョン**で、かつ
**本番D1に `0002_*` マイグレーションが未適用**の状態です。

旧バージョンの投稿コードは `username` カラムへ書き込まないため投稿自体は成功しますが、
サーバー一覧機能だけは `known_servers` テーブル（0002で作成）を参照するため、
テーブルが無いと500になります。また旧バージョンでは
ユーザー名変更が「24時間クールダウン」方式で、「1日5回まで」の制限は動きません。

どのバージョンが稼働しているかの見分け方:

```bash
# 管理画面のスクリプトを取得して確認
curl -s https://<あなたのworker URL>/admin.js | grep -o "username_daily_change_limit" | head -1
# → 何も表示されない（または username_change_cooldown が見つかる）場合は旧バージョン
#   新バージョンなら username_daily_change_limit が見つかる
```

対処手順（プロジェクトのルート＝`wrangler.toml`のある階層で実行）:
**マイグレーションを先に実行してからデプロイしてください**
（逆順でも一時的に投稿が500になるだけで復旧しますが、順番どおりが安全です）。

```bash
# 1. 依存関係のインストール（初回のみ）
npm install

# 2. D1マイグレーション（0002・0003を適用。何度実行しても安全・データは消失しない）
npm run db:migrate:remote
npm run db:migrate:shard1:remote
npm run db:migrate:shard2:remote

# 3. 新バージョンをデプロイ（1日5回制限を含む）
npx wrangler deploy
```

完了後は次のようになります:

- `GET /api/servers` が200を返し、板のトップにサーバー切り替えUIが表示される
- 設定ページのユーザー名変更が「1日5回まで」制限に変わる（6回目は429エラー）。
  上限値は管理画面の「1日あたりのユーザー名変更回数上限」から変更可能
- 投稿・スレッド作成時にユーザー名（未設定なら「名無しさん」）が記録される

### ブラウザのコンソールに「機能ポリシー」警告や file:/// のセキュリティエラーが表示される

Firefoxの開発者コンソールに次のようなメッセージが表示されることがありますが、
**いずれもサイトの不具合ではありません**:

- `機能ポリシー: 未サポートの機能名 "autoplay" をスキップします` など:
  Cloudflare Turnstile（bot対策ウィジェット）のスクリプトが宣言している
  機能ポリシー名を、Firefoxが「未対応」としてスキップしているだけの警告。
  Chromeでは表示されない、Turnstileを埋め込んだ全サイトで出る既知のノイズです。
- `分離された Cookie またはストレージアクセスが ... challenges.cloudflare.com ... に提供されました`:
  Firefoxのトラッキング分離（Total Cookie Protection）がTurnstileの
  サードパーティiframeを通常どおり分離したことを示す通知。想定内の動作です。
- `セキュリティエラー: ... のコンテンツが file:/// を読み込み、またはこれにリンクすることは禁止されています`:
  ブラウザが「ローカルファイル（file:///）へのアクセス試行」をブロックした記録です。
  cf-bbsのフロントエンドはユーザー入力をすべてプレーンテキストとして描画し
  （リンク自動生成すらしない設計）、コード内に `file://` への参照は一切存在しないため、
  **このエラーがサイト側のコードから発生することはありません**。
  ほとんどの場合、ローカルのファイルをブラウザ画面へドラッグ＆ドロップした、
  または拡張機能・ブックマークなどブラウザ側の要因です。掲示板の動作への影響はありません。

---

## 18. 管理ガイド（管理ページ・管理者権限・制限のリセット）

### 管理ページ（/admin.html）の開き方

管理ページのURLは **`https://<あなたのworker URL>/admin.html`** です。
トップバー右側の「管理」リンク（管理者としてログイン中のみ表示される）からも開けます。
「管理」リンクが表示されない場合は、そのアカウントに管理者ロールが付与されていません。
→ 次項の手順で付与してください。

### 最初の管理者（role=admin）を作る方法

方法A — 専用スクリプト（推奨・CLIからD1へ直接登録、パスワードはハッシュ化されて保存される）:

```bash
node scripts/create-admin.mjs
```

メールアドレス・ユーザー名・パスワード・PASSWORD_PEPPERを対話入力すると、
`users`テーブルへ role='admin' のアカウントを登録（既存メールならパスワード
リセット＋admin化）します。パスワードはWorker本体と完全に同じ方式
（PBKDF2-SHA256 / 100,000反復 / ランダムソルト）でハッシュ化され、
**平文では保存されません**。フラグ指定（`--email` / `--password` 等）で
対話を省略することもできます（`--help`参照。
`--pepper '値'` を指定すれば PASSWORD_PEPPER の対話入力自体もスキップできます）。

PASSWORD_PEPPERについて:
- `wrangler secret list` に PASSWORD_PEPPER が**無い**場合（未設定で運用中）、
  PEPPER入力は空欄でOK（スクリプトが自動判定します）
- 設定済みの場合は `wrangler secret put PASSWORD_PEPPER` で入れたのと
  **同じ値**を入力してください（一致しないとログインできません）
- スクリプト実行後、**ログインし直す**と管理者ロールが反映されます

方法B — アカウントが未登録の場合:
`wrangler.toml` の `BOOTSTRAP_ADMIN_EMAIL` にそのメールアドレスを設定してから
`npx wrangler deploy` し、そのメールで新規登録すると自動的に管理者になります。
確認後は `BOOTSTRAP_ADMIN_EMAIL` を空に戻して再デプロイしてください。

方法C — すでにアカウントがある場合（ダッシュボードのD1コンソールかローカルからSQL実行）:

```bash
npx wrangler d1 execute DB_MAIN --remote --command "UPDATE users SET role='admin' WHERE email='あなたのメールアドレス'"
```

実行後、**ログインし直す**とセッションに管理者ロールが反映され、
トップバーに「利用状況」「管理」リンクが現れます。

### 管理者によるパスワード再設定（v10新設）

管理画面「ユーザー」タブの各ユーザー行にある**「パスワード再設定」**ボタンから、
対象ユーザーのパスワードを管理者が再設定できます（ロックアウト救済・悪用対応用）。

- 新パスワードを入力するか、**空欄で確定すると仮パスワード（12文字の半角ランダム）を
  自動生成**して表示します（表示は1回限り・サーバー側には保存されません。
  ユーザーへ安全に伝達してください）
- 実行すると**対象ユーザーの全セッションが両モードで即時失効**します（v10.1）。
  JWTモードでも、変更前に発行されたトークンは書き込み系API・/me で即時拒否され、
  対象ユーザーは**全端末で再ログイン**が必要になります（0007マイグレーション）
- 操作は監査ログに `reset_password` として記録されます（生成の有無のみ記録し、
  パスワード自体は記録しません）

### ユーザー名変更の回数制限とリセット方法

- 旧バージョンの「24時間クールダウン」設定（`username_change_cooldown_hours`）は
  マイグレーション `0003` の適用時に自動削除されます。旧コードが稼働していると
  削除済みの設定キーをデフォルト値（24時間）で動かしてしまうため、
  **必ず新バージョンをデプロイ**してください。
- 新バージョンでは「1日あたりの変更回数上限（既定5回/日・UTC日付ベース）」方式です。
  上限値は管理画面「設定」タブの「1日あたりのユーザー名変更回数上限」から変更できます。
- 翌日（UTC）を待たずにカウントをリセットしたい場合（全ユーザー対象）:

```bash
npx wrangler d1 execute DB_MAIN --remote --command "DELETE FROM username_change_counts"
```

特定ユーザーだけリセットする場合:

```bash
npx wrangler d1 execute DB_MAIN --remote --command "DELETE FROM username_change_counts WHERE user_id=(SELECT user_id FROM users WHERE email='あなたのメールアドレス')"
```

（成功した変更のみカウントされ、失敗した試行は消費しません）

---

## 19. ストレージ別の用途と消費量（v2）

### KV / D1 / Cache API の用途一覧

| ストレージ | 用途 | 状態 |
|-----------|------|------|
| **KV** (SESSIONS_KV) | （旧セッションストア） | **v2で使用停止（消費ゼロ）**。バインディングはロールバック用に残置。新規セットアップでは削除可 |
| **D1 DB_MAIN** | ユーザーアカウント / 新着スレッド・投稿 / known_servers（サーバー一覧+稼働状態）/ server_access_stats（日次アクセス統計）/ d1_sessions（HMACモード時のセッション）/ api_keys（APIキー・v11）/ admin_daily_quotas（管理者向け1日回数制限・v11.2）/ admin_settings / admin_audit_log / archive_manifest / user_login_days / username_change_counts | 使用中 |
| **D1 SHARD_1 / SHARD_2** | 移行済みスレッド・投稿（スレッド単位で移行。db_shard_count設定に従う） | 使用中（設定で1〜3を選択） |
| **Cache API** | 投稿Rate Limit（1日上限・投稿間隔）/ ログイン試行ガード / レスポンスキャッシュ / 日次アクセスカウンタ | 使用中（**課金・無料枠カウント対象外**） |

### 1操作あたりの READ / WRITE 消費

認証（JWT検証・CSRF検証）はCPU上のHMAC計算のみで完結し、**ストレージアクセスゼロ**です。
「設定」読み取り（admin_settings）はIsolate内メモリに30秒キャッシュされるため、
表中のD1 Readは「キャッシュ無効時の最大値」です。

| 操作 | D1 Read | D1 Write | KV | Cache API | 備考 |
|------|---------|----------|----|-----------|------|
| **ログイン** | 2〜4クエリ | 1〜2 | **0** | 数回 | ユーザー照合+ログイン日記録。昇格判定で+1〜2。Turnstileオン時は+1外部fetch |
| **メールアドレス変更** | 1〜2クエリ | 1〜2 | **0** | 数回 | 本人照合+重複確認（UNIQUE制約が二重防御）。HMACモード時はセッション行のemail更新+1。現在パスワード検証のためにAuthGuardを適用（誤入力の連続でロック） |
| **パスワード変更** | 1〜2クエリ | 2〜3 | **0** | 数回 | 本人照合+新ハッシュ保存。旧セッション全削除+新セッション発行。失効時刻は同一UPDATE内で sessions_invalidated_at に記録（0007）。JWTモードでも古いトークンは書き込み系で即時拒否 |
| **アカウント削除（退会）** | 1〜2クエリ | 本人の行数分 | **0** | 数回 | 本人照合+全D1（main/shard1/shard2）の表示名匿名化+本人の行削除（login_days/改名カウント/セッション/users）。投稿0件なら書き込みは最小 |
| **スレッド作成** | 2〜3クエリ | 2 | **0** | 約4get+4put | ユーザー照合+スレッドSELECT → スレッドINSERT+本文INSERT |
| **返信投稿** | 3〜4クエリ | 2 | **0** | 約5get+5put | ユーザー照合+manifest+スレッドSELECT → 投稿INSERT+スレッド更新 |
| 板/スレッド閲覧（キャッシュヒット時） | 0 | 0 | **0** | 1get | D1はTTL内なら一切読まない（main 10秒/shard 120秒） |
| 板/スレッド閲覧（キャッシュ無効時） | 1〜3クエリ | 0 | **0** | 1get+1put | |
| サーバー一覧・health表示 | 1クエリ | 0 | **0** | 1get+1put | |
| スレッド名検索（v10） | 1クエリ | 0 | **0** | 1get+1put | `GET /api/threads?q=` 。LIKEのワイルドカードはエスケープ済み |
| 管理者パスワード再設定（v10） | 2〜3クエリ | 1〜2 | **0** | 数回 | 対象照合+新ハッシュ保存。HMACモード時はセッション全削除。自動生成時は生成コストのみ |
| 登録IP一括消去（v10） | 1クエリ | 変更行数分 | **0** | 数回 | `UPDATE users SET registration_ip = NULL` |
| APIキー発行/一覧/失効（v11） | 1〜3クエリ | 発行/失効時1〜2 | **0** | 0 | 設定「高度な機能」からの低頻度操作。発行/失効は監査ログに記録 |
| APIキーでの認証付きリクエスト（v11） | 2クエリ | 0〜1 | **0** | 通常通り | キー照合（SHA-256ハッシュ）+ユーザー行ロード。last_used_at は60秒に1回まで更新。BAN・退会は即反映 |
| サーバー手動レスポンスチェック（v11.2） | 3〜4クエリ | 2〜3 | **0** | 数回 | 生存確認fetch（8秒タイムアウト）+割当消費（INSERT/UPSERT+SELECT）+health更新+監査ログ。1管理者1日10回まで（JST日替わり） |

※ 旧バージョン（KVセッション）では、上記すべての認証付きリクエストに **KV Read 1回**、
ログイン時に **KV Write 1回** が加わっていました。v2ではどちらも **0** です。

### 認証方式（auth_mode）の比較

管理画面「設定」タブから切替できます（切替後のログインから適用。既存セッションは
期限まで継続。KVはどちらのモードでも使いません）:

| | JWT（既定） | HMACセッション |
|---|---|---|
| セッション実体 | Cookie内の署名済みトークン（ステートレス） | DB_MAINの d1_sessions 表 |
| 認証時のストレージ消費 | **0** | D1 Read 1回/リクエスト |
| ログアウト | Cookie削除のみ | **セッション行を即時削除（即時失効）** |
| BANの反映 | 次回の投稿時（D1 status再確認）・次回ログイン | **即時**（BAN操作でセッション全削除） |
| 期限 | 14日 | 14日（毎日cronで期限切れ行を掃除） |

---

## 20. アカウントセルフサービス機能（v9新設: メール変更・パスワード変更・退会）

`/settings.html` の一般ユーザー向け設定画面に、以下の3機能を追加した
（すべて管理者機能に依存しないセルフサービス。実装は `src/routes/auth.ts`）。

共通の安全設計:

- **現在のパスワードの再入力が必須**（離席中の端末での勝手な変更・退会、
  Cookie盗用時の被害限定）
- **Origin検証+CSRF検証**付き（他の状態変更APIと同一水準）
- パスワード照合の総当たり対策として、**ログインと同じ AuthGuard**（IP+メール
  単位の連続失敗ロック・Cache API）が効く。連続8回の失敗で一時ロック（429）
- Turnstileは要求しない（ログイン済み+CSRF+パスワード再検証で十分なため）

### メールアドレス変更（`PATCH /api/auth/email`）

- 新しいメールアドレス+現在のパスワードで変更。**再ログインは不要**
- `/api/auth/me` が常にDB上の最新emailを返すため、JWTモードでも表示は即座に切替わる
  （JWTのemailクレーム自体は古い値のまま残るが、表示・動作に影響はない）
- 重複不可（users.emailのUNIQUE制約+事前チェックの二重防御）
- HMACモードでは既存セッション行のemailも更新する

### パスワード変更（`POST /api/auth/password`）

- 現在のパスワード確認後、新しいソルトでPBKDF2ハッシュを再生成して保存
- 新パスワードは登録時と同じ基準（8〜`password_max_len`文字・半角）で検証する
- 変更に成功すると**他端末のセッションは両モードで即時失効**する（v10.1・0007）:
  - HMACモード: D1セッションを全件削除 → 他端末は即時ログアウト
  - JWTモード: 変更時刻が users.sessions_invalidated_at に記録され、それ以前に
    発行されたトークンは書き込み系API（投稿・アカウント変更・管理操作等）で
    401拒否・/me でも未ログイン扱い。公開データの閲覧はログイン不要のため実害なし
- 変更した端末には新しいセッションが発行されるため、そのまま使い続けられる

### アカウント削除（退会）（`POST /api/auth/delete-account`）

- 誤操作防止のため、**確認語「削除」の入力+現在のパスワード**の両方が必須
  （フロントエンドは加えて `window.confirm` でも確認する）
- 投稿・スレッド自体は**残る**（他の人の返信を含むスレッドを消すと共有
  コンテンツが失われるため）。表示名だけが空になり、**「名無しさん」と表示される**
  （DB_MAIN / shard1 / shard2 の全D1に対して表示名を匿名化）
- 本人の行（`users` / `user_login_days` / `username_change_counts` /
  `d1_sessions`）を削除。退会後は**同じメールアドレス・ユーザー名での再登録が可能**
- 退会した端末はログアウト状態になる。JWTモードで残存する古いトークンは
  `/api/auth/me` がユーザー行の消失を検出して未ログイン扱いにするため、
  投稿・閲覧認証とも不可（投稿APIは都度ユーザー行を確認するため確実）
- 管理者（role=admin）も自分のアカウントを削除できるが、全管理者が消えると
  管理画面に誰も入れなくなる（再作成は `scripts/create-admin.mjs` で可能）

---

## 21. 利用規約ページ（v10新設）

`/terms.html` を新設しました。設定ページ（`/settings.html`）の**最下部に
「利用規約を開く」リンク**があり、新しいタブで開けます。

- 内容は**編集可能なテンプレート**です（法的助言ではありません）。`public/terms.html`
  を直接編集し、サーバー名・管理者連絡先・最終更新日などを書き替えてください
- テンプレート冒頭に**管理者向けの編集案内バナー**を表示しています。
  編集が済んだらそのバナーを削除してください
- 第4条には「登録IPを記録する設定がONの場合がある」旨の説明を含めています
  （設定をONにした場合はこの条項が実際の運用と一致しているか確認してください）

## 22. 登録IPアドレスの記録（v10新設・既定OFF）

アカウント登録時のIPアドレス（`CF-Connecting-IP`）を保存するかどうかを
管理画面「設定」タブの「プライバシー・サーバー監視」セクションで選択できます
（`record_registration_ip`・**既定OFF**）。

- **OFF（既定）**: IPは一切保存しません（管理画面にも表示されません）
- **ON**: 新規登録時に `users.registration_ip` へ保存し、管理画面「ユーザー」タブの
  メールアドレス欄に「IP: xxx.xxx.xxx.xxx」と表示します。
  **ONにする前の既存ユーザーは遡って記録されません**
- 記録をOFFに戻した後もDBに残っている過去分は、同セクション下の
  **「保存済みの登録IPを一括消去」**ボタン（`POST /api/admin/privacy/purge-registration-ips`）で
  即時消去できます。消去操作は監査ログに記録されます
- 保存するのは登録時の1回のみで、投稿・ログイン時のIPは追跡しません
- 利用目的は利用規約（21章）に沿って説明し、法令・Cloudflare利用規約への配慮のもとで
  運用してください

---

## 23. ローカルエミュレーションテスト（wrangler dev・同梱スクリプト）

`scripts/` 配下には、Cloudflareのローカルエミュレータ（wrangler dev / miniflare）を
使って実際のAPI動作を検証するE2Eテストスクリプトを同梱しています。**リモートの
本番D1には一切触れません**（すべて`--local`のローカルSQLiteで動作）。
`wrangler.toml`のIDがプレースホルダー（REPLACE-WITH-*）のままでも実行できます。

```bash
# v10機能（スレッド名検索・登録IP・管理者パスワード再設定・自動削除伝播ほか）
bash scripts/test-v10.sh

# 回帰テスト一式（v8 JWT/クラスタ・v8 HMAC管理・v9 アカウント・v11 外部ツール拒否+APIキー・
# v11.2 サーバー手動レスポンスチェック）
bash scripts/run-regression.sh

# 単体で実行する場合の例（ TURNSTILE等はスクリプト内でテスト用値を設定済み）
bash scripts/smoke-test-v5.sh
bash scripts/test-turnstile-fix.sh
```

- 各テストは`wrangler dev`をポート8817/8787等で起動し、テスト完了後に自動停止します
- ローカルD1の状態は`.wrangler/state`配下に残ります（zipには同梱されません。
  気になる場合は`rm -rf .wrangler/state`でリセット可能）
- テストはローカル限定であり、合格/不合格は本番デプロイの動作保証を意味しません
  （本番では手順10の動作確認チェックリストを使用してください）

---

## 24. APIキー（外部ツール用）と外部ツールの既定拒否（v11新設）

v11から、書き込み系API（POST/PATCH/PUT/DELETE）は**ブラウザ発リクエストのみ**を
受け付けるように変わりました。ブラウザは同一オリジンへのこれらのメソッドで
必ず`Origin`ヘッダを送る一方、curl等の外部ツールは通常送らないため、
「`Origin`/`Referer`ヘッダが無い書き込みリクエスト」は403
（`external_tool_blocked`）で拒否されます。これが「標準で外部ツールからAPIを
叩けない」状態です（セッショントークンを盗まれていても、ブラウザを経由しない
リクエストでは書き込めません）。

外部ツールからの正規アクセス経路として、ログイン済みユーザーは設定画面
**「高度な機能」→「開く」→「APIキー」**からAPIキーを発行できます。

### APIキーの仕様

- 形式: `cfbk_` + ランダム43文字（base64url）。`Authorization: Bearer`ヘッダで送信する
- 保存: キー本体は平文保存せず、SHA-256ハッシュのみD1（api_keys表・マイグレーション0008）に保存。
  **全文は発行時の一度だけ表示**され、以後は設定画面でも先頭13文字（`cfbk_`+8文字）のみ
- 権限: 投稿・スレッド作成・ユーザー名変更などの**ユーザーレベルの操作のみ**。
  管理API（`/api/admin/*`）は管理者自身のキーでも403（キー認証時はrole=userに強制）。
  キーによるキーの発行/失効も不可（漏えいしたキーが新しいキーを作れない）
- 失効: 設定画面の「失効」ボタンで即時（行削除）。BAN・退会でも即時無効化。
  **パスワード変更では失効しない**（外部ツールの運用を壊さないため。失効手段は
  キー削除・BAN・退会の3つ）
- 上限: 1アカウント10本まで。発行/失効は監査ログに記録される
- Turnstile: 管理設定「投稿時にTurnstileを要求」がONでも、APIキーからの投稿は
  Turnstile対象外（キー所持が代替。投稿間隔・1日上限のRate Limitは通常投稿と同じく適用）

### 外部ツールからの使い方

```bash
# キーを発行したら、CookieやCSRFトークン不要でただ1つのヘッダだけでAPIを呼べる
curl -X POST https://あなたのサーバー.workers.dev/api/threads/1/posts \
  -H "Authorization: Bearer cfbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"body":"APIキーからの投稿"}'

# スレッド作成も同様
curl -X POST https://あなたのサーバー.workers.dev/api/threads \
  -H "Authorization: Bearer cfbk_..." \
  -H "Content-Type: application/json" \
  -d '{"title":"タイトル","body":"最初の投稿"}'
```

### 注意点

- v10以前に動いていた「curl + Cookie + CSRFトークン」方式のスクリプトは、
  v11から`Origin: https://...`ヘッダを追加しない限り403になります
  （正規経路はAPIキーへの移行を推奨。どうしても移行前形式のまま使う場合は
  `-H "Origin: https://あなたのサーバー.workers.dev"`を加えてください）
- 公開データの閲覧（GET）は従来どおりOrigin無し・ログイン無しで可能です
- サーバー間同期（`/api/sync/*`）はSYNC_SECRETによるHMAC署名で保護されており、
  この変更の影響を受けません

---

## 25. 管理画面の手動レスポンスチェック（v11.2新設）

管理画面「サーバー管理」タブの一覧の各行に**「チェック」ボタン**を追加しました。
押すとそのサーバーへの生存確認（`GET /api/health`・8秒タイムアウト）をその場で
実行し、結果を`known_servers.health`へ反映します。

- **応答あり** → 「稼働中」へ更新。一時的なエラーで「応答なし」になっていた
  サーバーを復旧させられます。連続到達不能日数（`dead_days`、サーバー自動削除の
  カウンタ）も0にリセットされます
- **応答なし** → 「応答なし」へ更新（判定基準は0:00の日次cron自動チェックと
  完全に同じ・`src/utils/serverHealth.ts`の共通関数を使用）。`dead_days`は
  触りません（自動削除カウンタは日次の複数担当チェックの多数決のみが進める）
- **回数制限**: 1管理者あたり1日10回まで（日本時間の0時にリセット・
  マイグレーション0009の`admin_daily_quotas`表で管理）。結果メッセージに
  「本日の残り: N/10」を表示します。上限を超えると429（`quota_exceeded`）
- 実行結果（稼働中/応答なし）は監査ログに記録されます
- **サーバー追加時も、応答確認が通った場合のみ登録し、その時点で「稼働中」として
  登録されます**（従来は「未確認」のまま翌0:00の自動チェック待ちだった）。
  この追加時の自動確認は回数制限の対象外です
- チェック対象は自分自身（常に稼働中表示）以外の既知サーバーのみ。一覧に無いURLは
  404で拒否されます

---

## 実装済み / 未実装 / 要追加設定 / 既知の制約

### 実装済み

- メール+パスワード+Turnstile による登録・ログイン（PBKDF2ハッシュ化）
- セッション管理（v2: **KV完全廃止**。JWT（ステートレス・ストレージ消費ゼロ）と
  HMAC（D1保存セッション・即時失効可）を管理画面から切替可能。HttpOnly Cookie・
  Session Fixation対策・セッション固定は両方式とも新規ランダムID発行で対処）
- CSRF対策（Session紐付けToken／Double Submit Cookie方式・ステートレス。JWTのjti / D1セッションのsession_idをHMAC対象）
- **APIキー（v11）**: 設定「高度な機能」から発行。SHA-256ハッシュ保存・発行時一度だけ全文表示・
  Bearer認証でOrigin/CSRF無しの外部ツール利用を許可・管理APIとキー自己増殖は不可・
  1アカウント10本まで・監査ログ記録
- **サーバー手動レスポンスチェック（v11.2）**: 管理画面「サーバー管理」の「チェック」ボタン。
  1管理者1日10回まで（JST日替わり・0009）。応答ありなら「稼働中」へ更新して
  一時的エラーから復旧（連続到達不能日数もリセット）。判定基準は日次cronと共通化。
  サーバー追加時は応答確認後に「稼働中」として登録（25章参照）
- Origin検証・Content-Type検証・Content-Length検証・巨大Body拒否
- **書き込み系APIの既定で外部ツール拒否（v11）**: ブラウザ発リクエスト（Origin/Referer必須）
  のみ受け付け、curl等は403。正規経路はAPIキー（24章参照）
- 投稿API（Rate Limit・権限チェック・Turnstile（設定でON/OFF可）・SQLi対策）
- Cache APIによるRate Limit（投稿間隔・1日上限・ログイン試行のブルートフォース対策）。
  KV書き込み枠を消費せず、R2/Durable Objectsのような追加の支払い設定も不要
- 新規ユーザー→通常ユーザーの自動昇格（異なるN日ログイン、Nは設定可能）
- Intl.Segmenterによる書記素クラスタベースの文字数制限、URL数制限
- XSS対策（プレーンテキスト保存＋フロントエンドのtextContent徹底、サーバー側エスケープ関数も同梱）
- D1シャーディング（スレッド単位でのMain→Shard1→Shard2移行）
- 保持期間(data_retention_days)を超えたデータの完全削除（R2の代わりにD1上で削除）
- スレッドID指定時のみ対象D1をルーティングして検索（一覧では全D1を無条件検索しない）
- Cache API（公開スレッド一覧・投稿一覧のみ。Session/アカウント情報は対象外）
- 管理画面（ユーザー検索・BAN/BAN解除・管理者昇格・投稿/スレッド非表示・削除・
  設定変更・シャード移行・保持期限超過分の削除・監査ログ）
- ハードコード禁止項目のD1管理設定化（Isolate内30秒キャッシュ付き）
- Primary/Backupドメインの区別・Origin許可リスト・手動リコンサイルAPIの土台
- Host Header Injection対策（許可ドメイン以外のHostを拒否）
- 監査ログ（管理操作の記録）
- ユーザー名機能（登録時に任意設定・`/settings.html`から変更可・1日あたり変更回数制限（既定5回/日）付き・
  投稿時点の表示名をposts/threadsへ非正規化保存）
- アカウントセルフサービス（v9）: 設定画面からの**メールアドレス変更・パスワード変更・
  アカウント削除（退会）**。いずれも現在パスワード再入力+CSRF必須・AuthGuardによる
  総当たり対策付き。パス変更で他端末失効（HMAC即時）、退会で投稿の表示名を
  「名無しさん」化して同メアド再登録を解放（詳細は20章）
- レス番号のクライアント側採番（投稿IDではなく、読み込まれたレスに1,2,3...と連番。
  スレッド見出しに「レス N件」も表示）
- テーマ切替（設定ページでダーク/ホワイトを選択、localStorageに保存、
  全ページ`theme.js`が描画前に適用してチラつきを防止。ライトはCatppuccin Latteベース）
- 設定ページへの「サーバ一覧」統合（選択画面・「開く」で該当サーバーの板へ移動、
  `?server=`パラメータ対応）＋ログインユーザーによるサーバー登録
  （`POST /api/servers/register`。実在確認・レート制限・監査ログ・announce伝播つき）
- サーバー種別（type）の基盤（`known_servers.type` = normal / anonymous。
  将来の匿名サーバー対応に備え、通常サーバーにはSVGアイコンを表示）
- ログアウトボタンの設定ページ下部への移動、トップバーへのユーザー名表示
- パスワードの文字数制限（8〜20文字、管理画面で変更可。既存ユーザーの
  ログインには影響しない）
- Turnstileの安定化（v6）：トークンは1回で消費されるため、送信失敗後・投稿成功後に
  ウィジェットを自動リセットして新しいトークンを取得。トークン未取得のままの送信は
  事前に案内して中断。期限切れは `refresh-expired: auto` で自動再発行。サイトの
  テーマに応じてウィジェットもライト/ダーク切替。サーバー側はsiteverifyの
  エラーコードに応じた日本語メッセージを返答
- 投稿時Turnstile要求のサーバー側強制（v6）：管理画面の「投稿時にTurnstileを
  要求する」がスレッド作成・返信の両APIで実際に機能（従来は表示のみ）
- 複数サーバー選択機能（板のトップ`/index.html`にインライン統合、`known_servers`のD1管理、
  admin追加時の1ホップannounce、手動sync-pull、announce受信時の簡易実在確認、
  公開読み取りエンドポイントのみCORSを開放してクロスオリジン閲覧を実現）
- `/status.html`（ログイン済みユーザー全員が閲覧可、D1ストレージ使用率・Workers本日リクエスト数を
  Cloudflare API経由で表示。D1行読み書き数・KV操作数はベストエフォート）
- スレッド画面の「← スレッド一覧に戻る」ボタン（他サーバー閲覧時は
  そのサーバー選択状態を保持したまま戻る）
- トップバー見出し「cf-bbs」のトップページリンク化（自サーバーの絶対URLへ）
- 返信投稿後のD1再取得なしでの即時画面反映（投稿APIの応答post_idと入力内容で
  クライアント側だけで一覧末尾へ追記・レス数カウンタ更新。D1読み取り回数削減）
- メールアドレス・パスワード入力欄の半角限定（入力時に全角・日本語等を自動除去。
  サーバー側でも登録時に検証）
- 管理画面「スレッド」タブ（サーバー内スレッド一覧・レス数・保存先シャード表示、
  ID検索（移行済みシャード含むmanifest解決）、非表示/表示復帰、
  「完全削除」＝レス全件ごとの実DELETE。監査ログ記録付き）
- 管理画面「ユーザー」タブの強化（開いた時点でアカウント一覧を自動表示・
  ユーザー名列・BAN理由表示）
- `scripts/create-admin.mjs`（CLIからD1へ管理者を直接登録。パスワードは
  Worker本体と同一方式でPBKDF2ハッシュ化して保存）
- 新規追加エンドポイント（/api/servers系・/api/admin/status）専用の
  IPベースDoS対策（`src/utils/dosGuard.ts`、BBS本体の投稿APIには不適用）
- レスポンシブUI（PC/スマホ双方に対応。タップ領域確保・iOS自動ズーム防止・
  横スクロール対応テーブル等）
- 投稿・返信・ログイン・登録・ユーザー名変更・管理操作のローディング表示
  （スピナー付きボタン、一覧読み込み中のスケルトン表示）
- `scripts/setup.sh`（2つ目以降のサーバーをワンコマンドで構築）
- 管理画面「概要」ダッシュボードタブ（`GET /api/admin/overview`）
- 管理画面からの認証方式切替（JWT ⇔ HMAC）と**使用するD1数（1〜3）の設定**（v2）
- 日次ヘルスチェック自動同期（v2）: 毎日23:59 JSTに各サーバーがアクセス統計を共有 →
  0:00に「前日アクセスが少なかった順」の最大3サーバー（総数3以下なら全員）が
  全サーバーの生存確認 → 0:01に結果を公開・取得して各サーバーのDBを更新。
  統計未転送のサーバーは担当から除外。サーバー間APIはSYNC_SECRETによる
  HMAC署名認証（タイムスタンプ付き・リプレイ緩和）
- サーバー登録時の即時配信の強化（v2）: 新規サーバーへは既知の全リストを
  ブートストラップ配信（手動sync-pull不要で一覧を即時把握）
- サーバー一覧の稼働状態表示（v2）: 設定ページのサーバー行に
  「稼働中 / 応答なし / 未確認」バッジ（最終確認時刻もツールチップ表示）
- HMACモードのBAN即時失効（v2）: BAN・role変更時にそのユーザーの全セッションを
  即時削除（JWTモードでは次回投稿時のD1 status確認と次回ログインで反映）
- **スレッド名検索（v10）**: 板トップの検索ボックスでスレッド名（title）の部分一致検索
  （`GET /api/threads?q=`・半角大文字小文字を区別しない・LIKE特殊文字エスケープ済み）
- **スレッド「一番下へ」ボタン（v10）**: スレッド画面の「戻る」ボタン横に配置。
  押したときに初めて最下部へスクロール（自動スクロールはしない）
- **利用状況の日次区切りをJST 0:03へ（v10）**: 日次アクセスカウンタ・日次投稿上限の
  「1日」の区切りを0:03 JSTに変更（0:00〜0:02の死活監視通信を前日に含めない）
- **管理者によるパスワード再設定（v10）**: ユーザー一覧から実行。仮パスワード自動生成対応・
  **両モードで即時失効（v10.1）**・監査ログ記録
- **登録IPの記録トグル（v10・既定OFF）**: ON時は登録時にIPを保存してユーザー一覧に表示、
  一括消去API付き（22章）
- **利用規約ページ（v10）**: `/terms.html` 新設（編集可能テンプレート）+設定ページ最下部にリンク
- **サーバー自動削除伝播（v10）**: 日次ヘルスチェックで連続到達不能が続いたサーバーを
  全サーバーのリストから削除（2台以上の担当多数決・日数しきい値は管理画面で変更可・
  14章参照）
- 管理画面のダークテーマ修正（v10）: 統計カード（登録ユーザー数など）の数字が
  ダークテーマで黒文字になり見えない問題を修正（`button.card` がテーマ色を継承）
- **パスワード変更時のセッション即時失効（v10.1）**: JWTモードでも、パスワード変更
  （管理者再設定・自己変更）より前に発行されたトークンを書き込み系API・/me で
  即時拒否（users.sessions_invalidated_at・0007マイグレーション。18章・20章参照）
- **サーバーお気に入り（v11）**: サーバ一覧ページ・設定ページのサーバー行の★で
  お気に入り登録/解除（端末ごとのlocalStorage保存・サーバー送信なし・ログイン不要）。
  お気に入りが1件でもあるとき板トップは「自分＋お気に入り」のみを表示し、
  無ければ全既知サーバーをおすすめとして表示（14章参照）
- **サーバ一覧ページ（v11）**: `/servers.html` 新設。既知の全サーバーを
  「自分 → お気に入り → その他」の順で一覧表示し、名前・URL検索（入力即絞り込み）、
  ★トグル、稼働状態バッジ、「開く」を備える。板トップの「サーバ一覧へ →」から移動
- ローカルエミュレーションテストの同梱（v11で同梱を再開・23章参照）:
  `scripts/test-v10.sh/mjs`・`run-regression.sh`・`test-v8-jwt-cluster.mjs`・
  `test-v8-hmac-admin.mjs`・`test-v9-account.mjs`・`smoke-test-v5.sh`・
  `test-turnstile-fix.sh`（いずれもwrangler devローカル実行・本番DB不接触）

### 未実装

- メールアドレスの所有権確認（確認メール送信）。Emailサービス連携は本プロジェクトの
  スコープ外のため、登録時にメールアドレスの実在確認は行っていません。
- 完全なユーザー列挙耐性（メール送信ベースの「登録済みなら通知」方式は未実装。
  現状はレスポンスメッセージを汎用化する対策のみ）。
- Backup→Primaryのデータ取り込みを行う自動化スクリプト・UI（APIエンドポイントの
  土台のみ実装。実際にBackup側からデータを抽出してPOSTする処理は未実装）。
- パスワードリセット機能（メール送信ベースの本人確認フロー。
  **管理者によるパスワード再設定はv10で実装済み** — 18章参照）。
- 投稿の編集機能（`edited_at`カラムはスキーマ上用意済みだがAPIは未実装）。
- **スレッド内のレス本文検索・全文検索**（スレッド名での一覧検索はv10で実装済み）。
- 削除したスレッドの復元機能（保持期間超過による削除は完全削除で復元不可）。
- 複数サーバー間でのBBSコンテンツ自体の同期（仕様どおり、各サーバーの
  掲示板内容は独立しています。同期されるのは「既知サーバー一覧」のみ）。
- サーバー一覧からの削除の伝播（管理画面での削除はローカルのみに反映され、
  他サーバーへは伝播しません）。
- announceの多段（2ホップ以上の）自動伝搬（無限ループ防止のため意図的に
  1ホップに制限。全サーバーへ行き渡らせるには手動sync-pullを併用してください）。
- ユーザー名の一意性チェックの大文字小文字正規化（現状は完全一致でのみ判定）。

### 要追加設定

- `wrangler.toml` 内の `REPLACE-WITH-*` をすべて実際のIDに置き換える。
- 5章の6つのシークレットをすべて設定する。
- Turnstile Site Key / Secret Keyを実際の値に差し替える。
- `PRIMARY_API_DOMAIN` / `BACKUP_API_DOMAIN` をCloudflareダッシュボードで
  Custom Domainとして紐付ける。
- `BOOTSTRAP_ADMIN_EMAIL` を設定して初回管理者を作成後、空文字に戻す。
- Cloudflareダッシュボードで「Always Use HTTPS」を有効化する
  （本実装はSecure Cookieを前提としており、HTTP経由ではセッションが機能しません）。
- 運用ポリシーに応じて `/admin.html` の設定画面で `data_retention_days` を確認・調整する。
- `/status.html` を使う場合のみ: `CF_API_TOKEN` シークレットと、`wrangler.toml` の
  `CF_ACCOUNT_ID` / `WORKER_SCRIPT_NAME` / `DB_MAIN_ID` / `DB_SHARD_1_ID` /
  `DB_SHARD_2_ID` / `SESSIONS_KV_ID` を設定する（15章参照）。
- 複数サーバー構成にする場合のみ: 2つ目以降のサーバーを別アカウントへ
  デプロイする。`bash scripts/setup.sh` を使うと1コマンドで完了します（14章参照）。
- 既存デプロイをこのバージョンへ更新する場合は、`npm run db:migrate:remote`
  等のマイグレーションコマンドを再実行して `0002_*` / `0003_*` / `0004_*` / `0005_*` / `0006_*` / `0007_*` / `0008_*` / `0009_*` を適用すること
  （`wrangler d1 migrations apply` は未適用分だけを自動検出して適用します。
  0005〜0009はDB_MAINのみの変更なので、`npm run db:migrate:remote` 1本でOK）。
  その後に `npx wrangler deploy` で新コードを反映する（マイグレーションが先）。
  ※ v2への更新後は**全ユーザーが一度再ログイン**が必要です（旧KVセッションは無効化）。

### 既知の制約

- **Cache APIベースのRate Limitはデータセンター単位の緩い一貫性しか持たない**
  ソフトな制限です。KVの書き込み枠(1,000回/日)を消費せず、Durable Objectsの
  ような追加の支払い設定への同意も不要ですが、理論上は複数の異なる
  Cloudflare拠点から同時にアクセスされた場合、投稿間隔・日次上限・
  ログイン試行制限がごくわずかに超過する可能性があります。Turnstile・
  アカウント作成のハードル・管理者による事後対応と組み合わせることで、
  実運用上は十分な精度と判断しています。より厳密な制御が必要な場合は
  Durable Objects等への置き換えを検討してください（ただしその場合、
  デプロイ時に料金プランへの同意を求められる可能性がある点に注意）。
- **JWTモードのステートレス性**: サーバー側にセッション実体がないため、
  ログアウトはCookie削除のみで、トークン自体は期限切れまで技術的には有効です
  （HttpOnly Cookieから取り出せない限り第三者に使い道はありません）。
  ただし**パスワード変更（管理者再設定・自己変更）に伴う失効はv10.1で対応済み**:
  変更時刻が users.sessions_invalidated_at に記録され、それ以前に発行された
  トークンは書き込み系API（投稿・アカウント変更・管理操作）と /me で即時拒否
  されます（0007マイグレーション）。閲覧は公開データのため実害ありません。
  BAN・role変更の反映は従来どおり「次回の書き込み時のD1 status確認 / 再ログイン」です。
  ログアウト含め認証のたびに即時反映される運用にする場合はHMACモードへ
  切替してください（D1セッション・BAN/ログアウト即時反映。認証毎にD1 read 1回）。
- **APIキーの性質（v11）**: パスワード変更（0007のセッション失効）では失効しません
  （失効はキー削除・BAN・退会）。またキー認証では毎回D1 read 2回（キー照合+ユーザー
  行ロード）を消費するため、高頻度の自動ポーリングには向きません（公開データの
  閲覧はログイン不要なので、キー無しのGETで代用してください）。
- **Workers KVの使用停止について**: v2ではKVに書き込むコードは存在しません。
  上限（1,000 write/日）を消費する要素はなくなりました。
- **PBKDF2の反復回数（既定10万回）とWorkers Free PlanのCPU時間制限（10ms/リクエスト）
  のトレードオフ**。環境によっては反復回数がこの制限に接近・超過する可能性があります。
  実際にFree Planで運用する際は、Cloudflareダッシュボードの実行時間メトリクスを
  確認し、必要に応じて反復回数を減らすか、Paid Planへの移行を検討してください。
- D1容量シャーディングは**スレッド単位**で行っており、1スレッド内の投稿を
  日付等でさらに分割することはしていません（部分的な不整合を避けるための設計判断）。
- 保持期間を超えて削除されたデータは復元できません（R2への退避はしていないため）。
- Primary/Backup構成は、別アカウント構成（構成B）の場合にデータの自動同期を
  行いません。手動リコンサイルAPIの土台のみ実装しています（詳細は11章）。
- 管理設定のキャッシュ（30秒）はWorker Isolateごとに独立しており、
  世界中のIsolateへ変更が伝播するまで最大30秒程度のばらつきが生じ得ます。
- **サーバー自動削除伝播の安全装置について（v10）**: 削除判定は「2台以上の担当からの
  報告」が前提のため、**総サーバー数2台の構成では自動削除が動作しません**
  （手動削除してください）。また、日数しきい値（`server_auto_removal_days`）は
  サーバーごとに設定できるため、しきい値が異なるサーバー間ではリスト内容が
  一時的に異なることがあります（次回の同期で収束します）。
- Cloudflareの各種Free Plan上限（Workers 100,000 req/日、Workers Subrequests
  50回/呼び出し、KV 100,000 read・1,000 write/日、D1 5,000,000 rows read・
  100,000 rows written/日・5GBストレージ）は、Cloudflareの公式ドキュメント
  （<https://developers.cloudflare.com/workers/platform/pricing/>、
  <https://developers.cloudflare.com/d1/platform/pricing/>）を実装時点（2026年9月）で
  確認したものです。**これらの数値は変更される可能性があるため、実際の運用前に
  必ず最新の公式ドキュメントを確認してください。**
- ローカル開発（`wrangler dev`）では、HTTP接続に対して `Secure` Cookieが
  送信されないため（ブラウザ・curlともに正しい挙動です）、ログイン状態を
  維持した動作確認をしたい場合はCookieを手動で付与するか、HTTPSを終端する
  トンネル（`cloudflared tunnel` 等）越しに確認してください。
- **複数サーバー機能はFree Planの上限を"回避"するものではなく、"複数のFree Plan
  アカウントへ処理を分け合う"ためのものです**。1つのアカウント内でいくら
  サーバーエントリを増やしても、そのアカウント自体のリクエスト数/D1/KV上限は
  変わりません。実際に処理能力を増やすには、別々のCloudflareアカウントへ
  それぞれデプロイする必要があります（11章の構成Bと同じ考え方です）。
- サーバー一覧の同期は前述のとおり最大1ホップのannounceと手動sync-pullのみで、
  常時リアルタイムに全サーバーへ伝播する保証はありません（小規模な運用を
  想定した現実的な妥協です）。
- 複数サーバー閲覧のためCORSを開放している4つのGETエンドポイント
  （`/api/public-config` `/api/servers` `/api/threads` `/api/threads/:id/posts`）は、
  Cookie等の認証情報を伴わない完全に読み取り専用の公開データです。
  そもそも掲示板として誰でも閲覧できる内容のため、任意オリジンからの
  閲覧を許可しても情報漏えい等のリスクはありません（状態変更API・
  認証系APIは従来どおり許可ドメインのみに制限されています）。
- `/status`のGraphQL Analytics APIクエリ（D1の読み書き数・KVの操作回数）は
  Cloudflare側のデータセット・フィールド名の変更に弱く、将来動作しなくなる
  可能性があります。動かない場合は取得元コード(`src/routes/status.ts`)を
  Cloudflareの最新のGraphQLスキーマに合わせて調整してください（Workersの
  リクエスト数とD1のストレージ使用量は比較的安定したAPIを使っているため、
  相対的に信頼度が高い項目です）。
- ユーザー名は登録時に必須ではないため、多くのユーザーが未設定のまま
  「名無しさん」で運用される可能性があります（意図した挙動です）。
