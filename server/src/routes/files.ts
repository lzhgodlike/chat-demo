import type { FastifyPluginAsync } from 'fastify'
import { requireUser } from '../auth.js'
import { currentUser, HttpError, readMultipartField } from '../http.js'
import { isImporting } from '../history/lock.js'

type FileRow = {
  name: string
  mime_type: string
  size: number
  data: Buffer
}

const isFileId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value)

export const fileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser)

  /** 保存会话附件原件；同一附件 id 重复上传时覆盖。 */
  app.put<{ Params: { id: string } }>('/:id', async (request) => {
    const user = currentUser(request)
    if (!isFileId(request.params.id)) {
      throw new HttpError(400, 'invalid_file_id', '附件标识不正确')
    }
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    const part = await request.file({ limits: { fileSize: app.config.maxFileBytes, files: 1 } })
    if (!part) {
      throw new HttpError(400, 'missing_file', '没有收到文件')
    }
    const buffer = await part.toBuffer()
    if (part.file.truncated) {
      throw new HttpError(413, 'file_too_large', '附件超过大小限制')
    }
    const name = (readMultipartField(part.fields, 'name') ?? part.filename ?? '').slice(0, 255)
    const mimeType = (
      readMultipartField(part.fields, 'mimeType') ??
      part.mimetype ??
      ''
    ).slice(0, 200)
    const size = buffer.byteLength

    const existing = app.db
      .prepare('SELECT size FROM files WHERE user_id = ? AND id = ?')
      .get(user.id, request.params.id) as { size: number } | undefined
    const usage = app.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?')
      .get(user.id) as { total: number }
    if (usage.total - (existing?.size ?? 0) + size > app.config.maxUserStorageBytes) {
      throw new HttpError(413, 'storage_quota_exceeded', '该账号的附件存储空间已满')
    }

    app.db
      .prepare(
        `INSERT INTO files (user_id, id, name, mime_type, size, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           name = excluded.name,
           mime_type = excluded.mime_type,
           size = excluded.size,
           data = excluded.data`
      )
      .run(user.id, request.params.id, name, mimeType, size, buffer, Date.now())

    return { id: request.params.id, name, mimeType, size }
  })

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = currentUser(request)
    if (!isFileId(request.params.id)) {
      throw new HttpError(400, 'invalid_file_id', '附件标识不正确')
    }
    const row = app.db
      .prepare('SELECT name, mime_type, size, data FROM files WHERE user_id = ? AND id = ?')
      .get(user.id, request.params.id) as FileRow | undefined
    if (!row) {
      throw new HttpError(404, 'not_found', '附件不存在')
    }
    const previewable =
      row.mime_type.startsWith('image/') || row.mime_type === 'application/pdf'
    return reply
      .type(row.mime_type || 'application/octet-stream')
      .header('content-length', String(row.size))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('content-disposition', previewable ? 'inline' : 'attachment')
      .header('cache-control', 'private, no-store')
      .send(row.data)
  })
}
