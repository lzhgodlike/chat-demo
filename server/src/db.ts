import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type AppDatabase = Database.Database

export type UserRow = {
  id: string
  username: string
  password_hash: string
  created_at: number
  disabled: number
}

export type SessionRow = {
  user_id: string
  id: string
  title: string
  created_at: number
  updated_at: number
  revision: number
  data: string
}

export type FileRow = {
  user_id: string
  id: string
  name: string
  mime_type: string
  size: number
  data: Buffer
  created_at: number
}

/** 只追加，不修改已有迁移；索引即数据库版本。 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_by_user ON auth_sessions(user_id);
  CREATE INDEX auth_sessions_by_expiry ON auth_sessions(expires_at);

  CREATE TABLE sessions (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 1,
    data        TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX sessions_by_user_updated ON sessions(user_id, updated_at DESC);

  CREATE TABLE session_files (
    user_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    file_id    TEXT NOT NULL,
    PRIMARY KEY (user_id, session_id, file_id)
  );
  CREATE INDEX session_files_by_file ON session_files(user_id, file_id);

  CREATE TABLE files (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE import_staging_sessions (
    user_id   TEXT NOT NULL,
    id        TEXT NOT NULL,
    title     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    file_ids  TEXT NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE import_staging_files (
    user_id   TEXT NOT NULL,
    id        TEXT NOT NULL,
    name      TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size      INTEGER NOT NULL,
    data      BLOB NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  `,
]

const migrate = (db: AppDatabase) => {
  const version = db.pragma('user_version', { simple: true }) as number
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[index])
      db.pragma(`user_version = ${index + 1}`)
    })()
  }
}

/** 打开数据库并执行迁移；`file` 可以是 `:memory:`（测试用）。 */
export const openDatabase = (file: string): AppDatabase => {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file)
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

/** 启动时清理上次中断留下的导入暂存。 */
export const clearAllImportStaging = (db: AppDatabase) => {
  db.transaction(() => {
    db.prepare('DELETE FROM import_staging_sessions').run()
    db.prepare('DELETE FROM import_staging_files').run()
  })()
}
