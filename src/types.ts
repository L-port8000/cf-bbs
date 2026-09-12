// 共有型定義・Bindings

export interface Env {
  // Static assets
  ASSETS: Fetcher;

  // D1
  DB_MAIN: D1Database;
  DB_SHARD_1: D1Database;
  DB_SHARD_2: D1Database;

  // KV (旧セッションストア。v2でJWT認証へ移行したため現在は未使用 — 消費ゼロ。
  // バインディングは旧バージョンからの切替・緊急ロールバックに備えて残置する。
  // 依存を減らしたい場合はREADMEの手順で削除可能)
  SESSIONS_KV: KVNamespace;

  // Vars
  ENVIRONMENT: string;
  DEPLOYMENT_ROLE: "primary" | "backup";
  PRIMARY_API_DOMAIN: string;
  BACKUP_API_DOMAIN: string;
  // 空文字なら付与しない。Primary/Backupが同一registrable domainのサブドメインで
  // 同一アカウント・同一バインディングを共有する場合のみ ".example.com" 等を設定する。
  COOKIE_DOMAIN: string;
  TURNSTILE_SITE_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL: string;
  // /status と複数サーバー選択機能で使う表示名（サーバー一覧に自分がどう
  // 名乗るか）。
  SERVER_DISPLAY_NAME: string;
  // /status がCloudflare GraphQL Analytics API / D1 Admin APIへ問い合わせる
  // ために必要な情報（任意機能。未設定でも他機能には影響しない）。
  CF_ACCOUNT_ID: string;
  WORKER_SCRIPT_NAME: string;
  DB_MAIN_ID: string;
  DB_SHARD_1_ID: string;
  DB_SHARD_2_ID: string;
  SESSIONS_KV_ID: string;

  // Secrets (wrangler secret put で設定する)
  TURNSTILE_SECRET_KEY: string;
  PASSWORD_PEPPER: string;
  SESSION_HMAC_SECRET: string;
  CSRF_HMAC_SECRET: string;
  SYNC_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN: string;
  // /status 用（任意）。Account Analytics:Read + D1:Read 権限のAPIトークン。
  CF_API_TOKEN: string;
}

export type UserRole = "user" | "admin";
export type UserTier = "new" | "regular";
export type UserStatus = "active" | "banned";
export type ContentStatus = "visible" | "hidden" | "deleted";
export type ShardName = "main" | "shard1" | "shard2";

// 認証方式（管理画面から切替可能。どちらもKV消費ゼロ）:
//   jwt  = ステートレスJWT（ストレージ消費ゼロ・即時失効は不可）
//   hmac = D1保存セッション（1リクエストD1 read 1回・ログアウト/BAN即時失効）
export type AuthTokenMode = "jwt" | "hmac";

export const DEFAULT_USERNAME = "名無しさん";

export interface UserRecord {
  user_id: string;
  email: string;
  username: string | null;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  role: UserRole;
  tier: UserTier;
  status: UserStatus;
  ban_reason: string | null;
  created_at: number;
  updated_at: number;
  // 登録時のIPアドレス（record_registration_ip設定がONのときのみ保存・既定OFF）。
  // 管理画面から一括消去可能。マイグレーション0006で追加された列。
  registration_ip?: string | null;
  // パスワードが最後に変更された時刻（UNIX秒・NULL=変更履歴なし）。
  // この時刻より前に発行されたセッション（JWT=iat / HMAC=セッション行作成時刻）は
  // 書き込み系APIで拒否される（0007マイグレーション参照）。
  sessions_invalidated_at?: number | null;
}

export interface SessionRecord {
  session_id: string;
  user_id: string;
  email: string;
  role: UserRole;
  csrf_secret: string;
  created_at: number;
  last_seen_at: number;
  // 認証経路（v11新設）。
  //   "cookie" = ブラウザのHttpOnly Cookie（既定・省略時もこちら扱い）
  //   "apikey" = 外部ツール用APIキー（Authorization: Bearer）。
  //              CSRF検証・Origin検査・パスワード変更失効の対象外になる
  //              （詳細はsrc/middleware/auth.ts参照）。roleは常に"user"へ強制。
  authVia?: "cookie" | "apikey";
}

export interface ThreadRecord {
  thread_id: number;
  title: string;
  created_by: string;
  username: string;
  created_at: number;
  last_activity_at: number;
  status: ContentStatus | "visible" | "hidden" | "deleted";
  origin: string;
}

export interface PostRecord {
  post_id: number;
  thread_id: number;
  user_id: string;
  username: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  status: ContentStatus;
  origin: string;
}

// サーバー種別。将来「匿名で投稿できるサーバー」と「アカウント必須の通常サーバー」
// を併存させるための基盤（現在は normal のみを実運用サポート）。
export type ServerType = "normal" | "anonymous";

// サーバーの稼働状態。日次ヘルスチェック（cron）の結果が反映される。
// unknown = まだ一度も確認されていない（または旧バージョンで登録された行）。
export type ServerHealth = "up" | "down" | "unknown";

export interface KnownServerRecord {
  url: string;
  name: string;
  type: ServerType;
  added_at: number;
  last_synced_at: number | null;
  health: ServerHealth;
  last_health_at: number | null;
  last_up_at: number | null;
  // 連続到達不能日数（日次ヘルスチェックの集約結果。マイグレーション0006で追加）。
  // server_auto_removal_days（既定3）に達すると全サーバーのリストから自動削除される。
  dead_days?: number;
}

export interface AdminSettings {
  daily_limit_new: number;
  daily_limit_regular: number;
  min_interval_new_sec: number;
  min_interval_regular_sec: number;
  max_body_len: number;
  max_urls: number;
  promotion_distinct_days: number;
  require_turnstile_on_post: boolean;
  require_turnstile_on_auth: boolean;
  data_retention_days: number;
  username_min_len: number;
  username_max_len: number;
  // 1日あたりのユーザー名変更回数上限（成功した変更のみをカウント）
  username_daily_change_limit: number;
  // パスワードの最大文字数（新規登録時のみ強制。ログイン時にはチェックしない）
  password_max_len: number;
  // 登録時にIPアドレスを記録するか（既定OFF。管理画面で切替・一括消去APIあり）
  record_registration_ip: boolean;
  // 連続到達不能日数がこの値に達した既知サーバーを全サーバーのリストから自動削除する
  // （1〜7日。0:00の日次ヘルスチェックで判定・0:01に削除伝播。詳細はcluster.ts参照）
  server_auto_removal_days: number;
  // 認証方式（"jwt" | "hmac"）。詳細は src/middleware/session.ts 参照
  auth_mode: AuthTokenMode;
  // 使用するD1の数（1〜3）。シャード移行・保持期間削除の挙動に影響する
  db_shard_count: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
