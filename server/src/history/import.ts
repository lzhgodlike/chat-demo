import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AppDatabase } from '../db.js'
import { toArrayBuffer } from '../binary.js'
import { HttpError } from '../http.js'
import { BackupError } from '../../../src/services/chat/history/errors.js'
import type { SessionIndexEntry } from '../../../src/services/chat/history/format.js'
import { imageType } from '../../../src/services/chat/history/imageType.js'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  USER_PATH,
  parseSessionPath,
  sessionFilesDir,
} from '../../../src/services/chat/history/paths.js'
import {
  checkManifest,
  readSessionFile,
  readSessionIndex,
} from '../../../src/services/chat/history/schema.js'
import { toLocalSession } from '../../../src/services/chat/history/toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from '../../../src/services/chat/history/zipReader.js'
import type { Session } from '../../../src/services/chat/types.js'
import { withImportLock } from './lock.js'

export type ImportMode = 'replace' | 'merge'

export type ImportLimits = {
  maxFileBytes: number
  maxUncompressedBytes: number
  maxStorageBytes: number
}

export type ImportResult = {
  sessions: number
  files: number
  skipped: number
}

const isSessionId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value)

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_archive', '备份文件 JSON 解析失败')
  }
}

const fileIdsOf = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  ),
]

const mapImportError = (error: unknown): unknown => {
  if (error instanceof HttpError) {
    return error
  }
  if (error instanceof BackupError || error instanceof ArchiveError) {
    return new HttpError(400, 'invalid_archive', '备份文件不完整或格式不受支持')
  }
  return error
}

/** 流式解析官方 v3 归档到暂存表，全部校验通过后在一个事务中替换或合并。 */
export const importUserArchive = async (
  db: AppDatabase,
  userId: string,
  archive: Blob,
  mode: ImportMode,
  limits: ImportLimits
): Promise<ImportResult> =>
  withImportLock(userId, async () => {
    if (!(await isZipFile(archive))) {
      throw new HttpError(400, 'invalid_archive', '请选择 DeepSeek 导出的 ZIP 文件')
    }

    const clearStaging = () => {
      db.prepare('DELETE FROM import_staging_sessions WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM import_staging_files WHERE user_id = ?').run(userId)
    }
    clearStaging()

    const stageSession = db.prepare(
      `INSERT INTO import_staging_sessions (user_id, id, title, created_at, updated_at, file_ids, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const stageFile = db.prepare(
      `INSERT INTO import_staging_files (user_id, id, name, mime_type, size, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO NOTHING`
    )

    const imported = new Set<string>()
    /** ZIP 条目名 → { 文件 id, 文件名 } */
    const images = new Map<string, { id: string; name: string }>()
    /** 已写入暂存的图片 id → MIME，同一图片出现在多个会话目录时只保存一次。 */
    const stored = new Map<string, string>()
    let manifest = false
    let index: SessionIndexEntry[] | undefined
    let currentSessionId: string | undefined
    let uncompressed = 0

    const saveImage = async (entry: ArchiveEntry, image: { id: string; name: string }) => {
      if (stored.has(image.id)) {
        await skipEntry(entry)
        return
      }
      const blob = await readEntry(entry)
      if (blob.size > limits.maxFileBytes) {
        throw new HttpError(413, 'file_too_large', `图片 ${image.name} 超过大小限制`)
      }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const mimeType = imageType(bytes.subarray(0, 16))
      stageFile.run(userId, image.id, image.name, mimeType, bytes.byteLength, Buffer.from(bytes))
      stored.set(image.id, mimeType)
    }

    try {
      for await (const entry of readArchive(archive)) {
        uncompressed += entry.size
        if (uncompressed > limits.maxUncompressedBytes) {
          throw new HttpError(413, 'archive_too_large', '解压后的备份内容超过服务器限制')
        }
        const { path } = entry
        const sessionId = parseSessionPath(path)
        if (!manifest) {
          if (path !== MANIFEST_PATH) {
            throw new HttpError(400, 'invalid_archive', '备份文件缺少 manifest.json')
          }
          checkManifest(await readJson(entry))
          manifest = true
        } else if (path === USER_PATH && !index && imported.size === 0) {
          // 账号信息已脱敏，不导入。
          await skipEntry(entry)
        } else if (sessionId !== null && !index) {
          const sessionFile = readSessionFile(await readJson(entry))
          if (sessionFile.id !== sessionId || imported.has(sessionId) || !isSessionId(sessionId)) {
            throw new HttpError(400, 'invalid_archive', '备份中的会话标识不合法')
          }
          const names = new Map<string, string>()
          for (const message of sessionFile.messages) {
            for (const fragment of message.fragments) {
              if (fragment.type === 'FILE') {
                for (const file of fragment.files) {
                  names.set(file.id, file.file_name)
                }
              }
            }
          }
          const local = toLocalSession(sessionFile)
          imported.add(sessionId)
          currentSessionId = sessionId
          for (const [imagePath, id] of local.images) {
            images.set(imagePath, { id, name: names.get(id) ?? id })
          }
          stageSession.run(
            userId,
            local.session.id,
            local.session.title,
            local.session.createdAt,
            local.session.updatedAt,
            JSON.stringify(fileIdsOf(local.session)),
            JSON.stringify(local.session)
          )
        } else if (path === INDEX_PATH && !index) {
          index = readSessionIndex(await readJson(entry))
        } else if (
          index
            ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
            : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
        ) {
          const image = images.get(path)
          await (image === undefined ? skipEntry(entry) : saveImage(entry, image))
        } else {
          throw new HttpError(400, 'invalid_archive', '备份文件条目顺序不合法')
        }
      }
    } catch (error) {
      clearStaging()
      throw mapImportError(error)
    }

    if (!manifest) {
      clearStaging()
      throw new HttpError(400, 'invalid_archive', '备份文件缺少 manifest.json')
    }
    const listed = new Set(index?.map((entry) => entry.id))
    if (
      !index ||
      listed.size !== index.length ||
      listed.size !== imported.size ||
      [...imported].some((id) => !listed.has(id))
    ) {
      clearStaging()
      throw new HttpError(400, 'invalid_archive', '会话索引与会话文件不一致')
    }

    try {
      return db.transaction(() => {
        const staged = db
          .prepare('SELECT COUNT(*) AS count FROM import_staging_sessions WHERE user_id = ?')
          .get(userId) as { count: number }
        const stagedFiles = db
          .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM import_staging_files WHERE user_id = ?')
          .get(userId) as { count: number; bytes: number }
        const kept = db
          .prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE user_id = ?')
          .get(userId) as { bytes: number }
        if ((mode === 'replace' ? 0 : kept.bytes) + stagedFiles.bytes > limits.maxStorageBytes) {
          throw new HttpError(413, 'storage_quota_exceeded', '导入后附件总量超过账号存储配额')
        }

        let skipped = 0
        if (mode === 'replace') {
          db.prepare('DELETE FROM session_files WHERE user_id = ?').run(userId)
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
          db.prepare('DELETE FROM files WHERE user_id = ?').run(userId)
        } else {
          const before = staged.count
          db.prepare(
            `DELETE FROM import_staging_sessions
              WHERE user_id = ? AND id IN (SELECT id FROM sessions WHERE user_id = ?)`
          ).run(userId, userId)
          const after = db
            .prepare('SELECT COUNT(*) AS count FROM import_staging_sessions WHERE user_id = ?')
            .get(userId) as { count: number }
          skipped = before - after.count
        }

        db.prepare(
          `INSERT INTO sessions (user_id, id, title, created_at, updated_at, revision, data)
           SELECT user_id, id, title, created_at, updated_at, 1, data
             FROM import_staging_sessions WHERE user_id = ?`
        ).run(userId)
        const stagedSessions = db
          .prepare('SELECT id, file_ids FROM import_staging_sessions WHERE user_id = ?')
          .all(userId) as { id: string; file_ids: string }[]
        const insertFileRef = db.prepare(
          'INSERT OR IGNORE INTO session_files (user_id, session_id, file_id) VALUES (?, ?, ?)'
        )
        for (const session of stagedSessions) {
          for (const fileId of JSON.parse(session.file_ids) as string[]) {
            insertFileRef.run(userId, session.id, fileId)
          }
        }
        db.prepare(
          `INSERT OR IGNORE INTO files (user_id, id, name, mime_type, size, data, created_at)
           SELECT user_id, id, name, mime_type, size, data, ?
             FROM import_staging_files WHERE user_id = ?`
        ).run(Date.now(), userId)
        const result = {
          sessions: stagedSessions.length,
          files: stagedFiles.count,
          skipped,
        }
        db.prepare('DELETE FROM import_staging_sessions WHERE user_id = ?').run(userId)
        db.prepare('DELETE FROM import_staging_files WHERE user_id = ?').run(userId)
        return result
      })()
    } catch (error) {
      clearStaging()
      throw mapImportError(error)
    } finally {
      clearStaging()
    }
  })

export type ArchiveSource = {
  blob: Blob
  cleanup: () => Promise<void>
}

/** 把 multipart 上传写到临时文件，使用 openAsBlob 让读取端按需读取，避免整个 ZIP 常驻内存。 */
export const createArchiveSource = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<ArchiveSource> => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-demo-import-'))
  const file = path.join(dir, 'archive.zip')
  const cleanup = async () => {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
  try {
    await pipeline(stream, fs.createWriteStream(file))
    const stat = await fs.promises.stat(file)
    if (stat.size > maxBytes) {
      throw new HttpError(413, 'payload_too_large', '备份文件超过大小限制')
    }
    const openAsBlob = (fs as typeof fs & { openAsBlob?: (file: string) => Promise<Blob> })
      .openAsBlob
    const blob = openAsBlob
      ? await openAsBlob(file)
      : new Blob([toArrayBuffer(await fs.promises.readFile(file))], { type: 'application/zip' })
    return { blob, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
