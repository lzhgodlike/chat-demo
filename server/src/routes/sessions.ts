import type { FastifyPluginAsync } from 'fastify'
import { requireUser } from '../auth.js'
import { currentUser, HttpError } from '../http.js'
import { isImporting } from '../history/lock.js'
import type { Session, SessionSummary } from '../../../src/services/chat/types.js'

type SessionRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  revision: number
  data: string
}

class RevisionConflict extends Error {
  constructor(
    readonly revision: number,
    readonly data: string
  ) {
    super('Revision conflict')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isFileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** 只做容器级校验；消息内容属于用户自己的数据，保持宽松以免阻断正常保存。 */
const parseSession = (value: unknown): Session => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
    typeof value.title !== 'string' ||
    value.title.length > 1000 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !Array.isArray(value.messages)
  ) {
    throw new HttpError(400, 'invalid_session', '会话数据格式不正确')
  }
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      !isFiniteNumber(message.createdAt)
    ) {
      throw new HttpError(400, 'invalid_session', '会话消息格式不正确')
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string' || !Array.isArray(message.files)) {
        throw new HttpError(400, 'invalid_session', '会话消息格式不正确')
      }
      if (!message.files.every((file) => isRecord(file) && isFileId(file.id))) {
        throw new HttpError(400, 'invalid_session', '附件标识不正确')
      }
    } else if (!Array.isArray(message.blocks) || typeof message.status !== 'string') {
      throw new HttpError(400, 'invalid_session', '会话消息格式不正确')
    }
  }
  return value as unknown as Session
}

const fileIdsOf = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  ),
]

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser)

  app.get('/', async (request): Promise<SessionSummary[]> => {
    const user = currentUser(request)
    const rows = app.db
      .prepare(
        'SELECT id, title, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC'
      )
      .all(user.id) as Pick<SessionRow, 'id' | 'title' | 'created_at' | 'updated_at'>[]
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  })

  app.get<{ Params: { id: string } }>('/:id', async (request) => {
    const user = currentUser(request)
    const row = app.db
      .prepare('SELECT data, revision FROM sessions WHERE user_id = ? AND id = ?')
      .get(user.id, request.params.id) as Pick<SessionRow, 'data' | 'revision'> | undefined
    if (!row) {
      throw new HttpError(404, 'not_found', '会话不存在')
    }
    return { session: JSON.parse(row.data) as Session, revision: row.revision }
  })

  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    const body = request.body
    if (!isRecord(body)) {
      throw new HttpError(400, 'invalid_request', '请求参数不合法')
    }
    const session = parseSession(body.session)
    if (session.id !== request.params.id) {
      throw new HttpError(400, 'invalid_session', '会话标识不一致')
    }
    const rawRevision = body.baseRevision
    let baseRevision: number | undefined
    if (rawRevision !== undefined) {
      if (typeof rawRevision !== 'number' || !Number.isSafeInteger(rawRevision)) {
        throw new HttpError(400, 'invalid_request', 'revision 不合法')
      }
      baseRevision = rawRevision
    }
    const fileIds = fileIdsOf(session)
    const data = JSON.stringify(session)

    try {
      const result = app.db.transaction(() => {
        const existing = app.db
          .prepare('SELECT revision FROM sessions WHERE user_id = ? AND id = ?')
          .get(user.id, session.id) as Pick<SessionRow, 'revision'> | undefined
        if (baseRevision !== undefined && existing && existing.revision !== baseRevision) {
          const latest = app.db
            .prepare('SELECT revision, data FROM sessions WHERE user_id = ? AND id = ?')
            .get(user.id, session.id) as Pick<SessionRow, 'revision' | 'data'>
          throw new RevisionConflict(latest.revision, latest.data)
        }
        const revision = (existing?.revision ?? 0) + 1
        app.db
          .prepare(
            `INSERT INTO sessions (user_id, id, title, created_at, updated_at, revision, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, id) DO UPDATE SET
               title = excluded.title,
               created_at = excluded.created_at,
               updated_at = excluded.updated_at,
               revision = excluded.revision,
               data = excluded.data`
          )
          .run(
            user.id,
            session.id,
            session.title,
            session.createdAt,
            session.updatedAt,
            revision,
            data
          )
        app.db
          .prepare('DELETE FROM session_files WHERE user_id = ? AND session_id = ?')
          .run(user.id, session.id)
        const insertFile = app.db.prepare(
          'INSERT OR IGNORE INTO session_files (user_id, session_id, file_id) VALUES (?, ?, ?)'
        )
        for (const fileId of fileIds) {
          insertFile.run(user.id, session.id, fileId)
        }
        return { revision }
      })()
      return { revision: result.revision, updatedAt: session.updatedAt }
    } catch (error) {
      if (error instanceof RevisionConflict) {
        return reply.code(409).send({
          error: { code: 'revision_conflict', message: '会话已在其他设备更新' },
          session: JSON.parse(error.data) as Session,
          revision: error.revision,
        })
      }
      throw error
    }
  })

  app.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    const body = request.body
    if (!isRecord(body) || typeof body.title !== 'string') {
      throw new HttpError(400, 'invalid_request', '请求参数不合法')
    }
    const title = body.title
    if (title.length > 1000) {
      throw new HttpError(400, 'invalid_title', '标题过长')
    }
    const row = app.db
      .prepare('SELECT revision, data FROM sessions WHERE user_id = ? AND id = ?')
      .get(user.id, request.params.id) as Pick<SessionRow, 'revision' | 'data'> | undefined
    if (!row) {
      throw new HttpError(404, 'not_found', '会话不存在')
    }
    const session = JSON.parse(row.data) as Session
    session.title = title
    app.db
      .prepare('UPDATE sessions SET title = ?, data = ?, revision = ? WHERE user_id = ? AND id = ?')
      .run(title, JSON.stringify(session), row.revision + 1, user.id, request.params.id)
    return { revision: row.revision + 1 }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    app.db.transaction((userId: string, sessionId: string) => {
      const rows = app.db
        .prepare('SELECT file_id FROM session_files WHERE user_id = ? AND session_id = ?')
        .all(userId, sessionId) as { file_id: string }[]
      app.db
        .prepare('DELETE FROM session_files WHERE user_id = ? AND session_id = ?')
        .run(userId, sessionId)
      app.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(userId, sessionId)
      const removeFile = app.db.prepare(
        `DELETE FROM files
          WHERE user_id = ? AND id = ?
            AND NOT EXISTS (
              SELECT 1 FROM session_files WHERE user_id = ? AND file_id = ?
            )`
      )
      for (const { file_id: fileId } of rows) {
        removeFile.run(userId, fileId, userId, fileId)
      }
    })(user.id, request.params.id)
    return { ok: true }
  })

  app.delete('/', async (request) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    app.db.transaction((userId: string) => {
      app.db.prepare('DELETE FROM session_files WHERE user_id = ?').run(userId)
      app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      app.db.prepare('DELETE FROM files WHERE user_id = ?').run(userId)
    })(user.id)
    return { ok: true }
  })
}
