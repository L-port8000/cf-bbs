// D1容量分散（シャーディング）と、保持期間を超えた投稿の自動削除を管理する。
// R2は使用しない（Cloudflareアカウントによっては有効化に支払い設定への
// 同意が必要になる場合があり、本プロジェクトでは採用しないこととした）。
//
// 設計方針（README「既知の制約」にも明記）:
//   - 移行の単位は「スレッド全体」。スレッド途中で投稿だけを別DBへ分割する
//     ことはしない（部分的な不整合を避けるため）。
//   - archive_manifest テーブル（DB_MAINのみに存在）が「どのスレッドが
//     どのD1に存在するか」を一元管理する。行が無いスレッドは
//     DB_MAIN上に存在するものとして扱う。
//   - 板のスレッド一覧（新着順）は原則 DB_MAIN のみを検索する。
//     移行されたスレッドは定義上「最近activityが無い」ため一覧には
//     出さず、スレッドIDを指定した個別アクセス時にのみ manifest を引いて
//     対象DBへルーティングする（「すべてのD1を無条件検索しない」要件）。
//   - 移行チェーンは Main → Shard1 → Shard2。Shard2からは、これ以上
//     D1を増やす代わりに、設定された保持期間(data_retention_days)を
//     超えた投稿データを削除して容量を確保する
//     （D1作成上限・保存領域確保が困難な場合の要求仕様に対応）。
//   - 移行・削除はいずれもCPU/Subrequest制限を考慮し、1回の呼び出しで
//     少数スレッド（既定20件）のみをバッチ処理する。管理画面から手動実行
//     するか、Cron Triggerで定期実行する。
//   - D1はデータベースをまたいだトランザクションを提供しないため、
//     移行は「対象DBへINSERT→manifest更新→元DBから削除」の順で
//     行うベストエフォート実装。途中で失敗した場合は次回実行時に
//     再試行され、対象DB側の重複INSERTはpost_id/thread_idのPRIMARY KEY
//     により自然に防止される（IGNORE系クエリで冪等化）。

import type { Env, PostRecord, ShardName, ThreadRecord } from "../types";

export function getShardDb(env: Env, shard: ShardName): D1Database {
  switch (shard) {
    case "main":
      return env.DB_MAIN;
    case "shard1":
      return env.DB_SHARD_1;
    case "shard2":
      return env.DB_SHARD_2;
  }
}

export async function getThreadShard(env: Env, threadId: number): Promise<ShardName> {
  const row = await env.DB_MAIN.prepare("SELECT shard FROM archive_manifest WHERE thread_id = ? LIMIT 1")
    .bind(threadId)
    .first<{ shard: ShardName }>();
  return row?.shard ?? "main";
}

export async function upsertManifest(
  env: Env,
  threadId: number,
  shard: ShardName,
  postCount: number,
  now: number
): Promise<void> {
  await env.DB_MAIN.prepare(
    `INSERT INTO archive_manifest (thread_id, shard, post_count, migrated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET shard = excluded.shard, post_count = excluded.post_count,
       migrated_at = excluded.migrated_at`
  )
    .bind(threadId, shard, postCount, now)
    .run();
}

// manifest行を削除する。管理画面からのスレッド完全削除（admin.tsの
// handlePurgeThread）からも使うためexportしている。
export async function deleteManifestEntry(env: Env, threadId: number): Promise<void> {
  await env.DB_MAIN.prepare("DELETE FROM archive_manifest WHERE thread_id = ?").bind(threadId).run();
}

export interface MigrationResult {
  migratedThreadIds: number[];
}

// sourceShard上で「最終活動がcutoff以前」のスレッドをtargetShardへ移す。
// sourceShard='main'の場合はDB_MAIN上の未移行スレッド（manifestに行が無い、
// または shard='main' のもの）が対象になる。
export async function migrateOldThreads(
  env: Env,
  sourceShard: "main" | "shard1",
  targetShard: "shard1" | "shard2",
  cutoffTs: number,
  batchLimit = 20
): Promise<MigrationResult> {
  const sourceDb = getShardDb(env, sourceShard);
  const targetDb = getShardDb(env, targetShard);

  let threads: ThreadRecord[];
  if (sourceShard === "main") {
    const candidates = await env.DB_MAIN.prepare(
      `SELECT t.* FROM threads t
       LEFT JOIN archive_manifest m ON m.thread_id = t.thread_id
       WHERE (m.shard IS NULL OR m.shard = 'main')
         AND t.last_activity_at < ?
       ORDER BY t.last_activity_at ASC
       LIMIT ?`
    )
      .bind(cutoffTs, batchLimit)
      .all<ThreadRecord>();
    threads = candidates.results ?? [];
  } else {
    // shard1 → shard2 の場合、対象スレッドの一覧はDB_MAINのmanifestから
    // 探し、実データ(last_activity_at等)はsourceDb(DB_SHARD_1)から取得する。
    const manifestRows = await env.DB_MAIN.prepare(
      `SELECT thread_id FROM archive_manifest WHERE shard = ? LIMIT ?`
    )
      .bind(sourceShard, batchLimit * 4) // 余裕を持って取得し、下でcutoff判定する
      .all<{ thread_id: number }>();
    const ids = (manifestRows.results ?? []).map((r) => r.thread_id);
    threads = [];
    for (const id of ids) {
      if (threads.length >= batchLimit) break;
      const t = await sourceDb.prepare("SELECT * FROM threads WHERE thread_id = ?").bind(id).first<ThreadRecord>();
      if (t && t.last_activity_at < cutoffTs) threads.push(t);
    }
  }

  const migrated: number[] = [];

  for (const thread of threads) {
    const posts = await sourceDb.prepare("SELECT * FROM posts WHERE thread_id = ?").bind(thread.thread_id).all<PostRecord>();
    const postRows = posts.results ?? [];

    // 1) 対象シャードへスレッド本体を書き込み（冪等: 既に存在すれば無視）
    await targetDb
      .prepare(
        `INSERT OR IGNORE INTO threads (thread_id, title, created_by, created_at, last_activity_at, status, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(thread.thread_id, thread.title, thread.created_by, thread.created_at, thread.last_activity_at, thread.status, thread.origin)
      .run();

    // 2) 投稿を対象シャードへ書き込み（バッチはD1の1トランザクション内で実行）
    if (postRows.length > 0) {
      const stmts = postRows.map((p) =>
        targetDb
          .prepare(
            `INSERT OR IGNORE INTO posts (post_id, thread_id, user_id, body, created_at, edited_at, status, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(p.post_id, p.thread_id, p.user_id, p.body, p.created_at, p.edited_at, p.status, p.origin)
      );
      await targetDb.batch(stmts);
    }

    // 3) manifestを更新（先に更新してから元DBを削除する。途中失敗しても
    //    読み取り経路はmanifestを見て新DBを優先するため安全側に倒れる）
    await upsertManifest(env, thread.thread_id, targetShard, postRows.length, Date.now());

    // 4) 元DBから削除
    await sourceDb.prepare("DELETE FROM posts WHERE thread_id = ?").bind(thread.thread_id).run();
    await sourceDb.prepare("DELETE FROM threads WHERE thread_id = ?").bind(thread.thread_id).run();

    migrated.push(thread.thread_id);
  }

  return { migratedThreadIds: migrated };
}

export interface DeletionResult {
  deletedThreadIds: number[];
}

// DB_MAIN上の「manifestに行が無い（またはshard='main'）」スレッドのうち、
// 保持期間を超えたものを実削除する（db_shard_count=1の構成用。
// shard1/shard2を使わない場合でも容量確保の自動削除が機能するようにする）。
export async function deleteExpiredThreadsInMain(env: Env, cutoffTs: number, batchLimit = 20): Promise<DeletionResult> {
  const rows = await env.DB_MAIN.prepare(
    `SELECT t.thread_id FROM threads t
     LEFT JOIN archive_manifest m ON m.thread_id = t.thread_id
     WHERE (m.shard IS NULL OR m.shard = 'main') AND t.last_activity_at < ?
     LIMIT ?`
  )
    .bind(cutoffTs, batchLimit)
    .all<{ thread_id: number }>();

  const deleted: number[] = [];
  for (const { thread_id } of rows.results ?? []) {
    await env.DB_MAIN.prepare("DELETE FROM posts WHERE thread_id = ?").bind(thread_id).run();
    await env.DB_MAIN.prepare("DELETE FROM threads WHERE thread_id = ?").bind(thread_id).run();
    deleted.push(thread_id);
  }
  return { deletedThreadIds: deleted };
}

// ---------------------------------------------------------------------------
// 日次メンテナンス（cron・管理画面の手動実行から呼ぶ）。
// 「使用するD1の数（db_shard_count・管理画面で1〜3を設定）」に応じて
// 移行チェーンと保持期間削除の対象が変わる:
//   1 = 移行なし。保持期間超過分はDB_MAINから直接削除
//   2 = main→shard1へ移行。保持期間超過分はshard1から削除
//   3 = main→shard1→shard2へ移行。保持期間超過分はshard2から削除（従来動作）
// 設定を下げてもデータは自動では戻らない（既に移行済みのスレッドはmanifest経由
// で引き続き閲覧可能）。
// ---------------------------------------------------------------------------
export async function runDailyMaintenance(
  env: Env,
  settings: { db_shard_count: number; data_retention_days: number }
): Promise<string[]> {
  const now = Date.now();
  const logs: string[] = [];
  const count = Math.min(3, Math.max(1, Math.floor(settings.db_shard_count)));

  if (count >= 2) {
    const r = await migrateOldThreads(env, "main", "shard1", now - 180 * 86400 * 1000, 20);
    logs.push(`main->shard1: migrated=${r.migratedThreadIds.length}`);
  }
  if (count >= 3) {
    const r = await migrateOldThreads(env, "shard1", "shard2", now - 365 * 86400 * 1000, 20);
    logs.push(`shard1->shard2: migrated=${r.migratedThreadIds.length}`);
  }

  const cutoff = now - Math.max(1, Math.floor(settings.data_retention_days)) * 86400 * 1000;
  if (count >= 3) {
    const r = await deleteExpiredThreads(env, "shard2", cutoff, 20);
    logs.push(`shard2 expired: deleted=${r.deletedThreadIds.length}`);
  } else if (count === 2) {
    const r = await deleteExpiredThreads(env, "shard1", cutoff, 20);
    logs.push(`shard1 expired: deleted=${r.deletedThreadIds.length}`);
  } else {
    const r = await deleteExpiredThreadsInMain(env, cutoff, 20);
    logs.push(`main expired: deleted=${r.deletedThreadIds.length}`);
  }
  return logs;
}

// 保持期間(retentionDays相当のcutoffTs)を超えたスレッドを、指定シャードから
// 完全に削除する（要求仕様: 「D1の作成上限に達した場合や保存領域が確保
// できない場合は、設定された保持期間に従い最も古い投稿データを削除して
// 容量を確保する」に対応）。削除後はmanifestの行も削除する（行が無い状態は
// 通常"main"扱いになるが、実データがどこにも存在しないため、そのスレッドID
// へのアクセスは自然に404となる）。
export async function deleteExpiredThreads(
  env: Env,
  shard: "shard1" | "shard2",
  cutoffTs: number,
  batchLimit = 20
): Promise<DeletionResult> {
  const db = getShardDb(env, shard);

  const manifestRows = await env.DB_MAIN.prepare(`SELECT thread_id FROM archive_manifest WHERE shard = ?`)
    .bind(shard)
    .all<{ thread_id: number }>();
  const ids = (manifestRows.results ?? []).map((r) => r.thread_id);

  const deleted: number[] = [];
  for (const id of ids) {
    if (deleted.length >= batchLimit) break;
    const t = await db.prepare("SELECT last_activity_at FROM threads WHERE thread_id = ?").bind(id).first<{ last_activity_at: number }>();
    if (!t) {
      // データが既に存在しない場合はmanifestの不整合として掃除する
      await deleteManifestEntry(env, id);
      continue;
    }
    if (t.last_activity_at < cutoffTs) {
      await db.prepare("DELETE FROM posts WHERE thread_id = ?").bind(id).run();
      await db.prepare("DELETE FROM threads WHERE thread_id = ?").bind(id).run();
      await deleteManifestEntry(env, id);
      deleted.push(id);
    }
  }

  return { deletedThreadIds: deleted };
}
