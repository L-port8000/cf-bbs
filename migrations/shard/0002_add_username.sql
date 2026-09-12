-- DB_SHARD_1 / DB_SHARD_2 共通: 投稿・スレッドの表示名カラムを追加。
-- DB_MAINの0002マイグレーションと対になる変更（理由はそちらのコメント参照）。

ALTER TABLE threads ADD COLUMN username TEXT NOT NULL DEFAULT '名無しさん';
ALTER TABLE posts ADD COLUMN username TEXT NOT NULL DEFAULT '名無しさん';
