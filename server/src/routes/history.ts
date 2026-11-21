import { Readable } from 'node:stream'
import type { FastifyPluginAsync } from 'fastify'
import { requireUser } from '../auth.js'
import { currentUser, HttpError } from '../http.js'
import { createArchiveSource, importUserArchive, type ImportMode } from '../history/import.js'
import { exportUserArchive } from '../history/export.js'
import { isImporting } from '../history/lock.js'

const formatDate = (date: Date) => date.toISOString().slice(0, 10)

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser)

  /** 上传官方导出 ZIP；默认覆盖服务器上的全部会话，mode=merge 时跳过已存在会话。 */
  app.post('/import', async (request) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    const query = request.query as { mode?: string } | undefined
    const mode: ImportMode = query?.mode === 'merge' ? 'merge' : 'replace'
    const part = await request.file({
      limits: { fileSize: app.config.maxImportBytes, files: 1 },
    })
    if (!part) {
      throw new HttpError(400, 'missing_file', '没有收到备份文件')
    }
    const source = await createArchiveSource(part.file, app.config.maxImportBytes)
    try {
      return await importUserArchive(app.db, user.id, source.blob, mode, {
        maxFileBytes: app.config.maxFileBytes,
        maxUncompressedBytes: app.config.maxImportUncompressedBytes,
        maxStorageBytes: app.config.maxUserStorageBytes,
      })
    } finally {
      await source.cleanup()
    }
  })

  /** 导出为官方 v3 ZIP，可直接再导入本应用或官方网页端。 */
  app.get('/export', async (request, reply) => {
    const user = currentUser(request)
    if (isImporting(user.id)) {
      throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
    }
    const blob = await exportUserArchive(app.db, user.id)
    const name = `deepseek_data-${formatDate(new Date())}.zip`
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('content-length', String(blob.size))
      .header('cache-control', 'no-store')
    return reply.send(Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]))
  })
}
