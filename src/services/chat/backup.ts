import { formatDate } from '../../utils/format.js'
import { SERVER_MODE } from '../runtime.js'
import * as db from './db.js'
import {
  exportHistoryFromServer,
  historyStore,
  importHistoryToServer,
  type ImportMode,
} from './storage.js'
import { replaceHistory, replaceHistoryFromServer, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入；服务器模式下载服务端数据。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    if (SERVER_MODE) {
      return exportHistoryFromServer()
    }
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 * 服务器模式把 ZIP 上传到服务端，由服务端完成原子替换或合并。
 */
export const importHistory = (file: File, mode: ImportMode = 'replace'): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    if (SERVER_MODE) {
      let imported = 0
      await replaceHistoryFromServer(async () => {
        const result = await importHistoryToServer(file, mode)
        imported = result.sessions
      })
      return imported
    }
    return replaceHistory(() => importArchive(file))
  })

/** 确认删除后调用：服务器模式清空服务端数据，否则原子替换本地历史。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    if (SERVER_MODE) {
      await replaceHistoryFromServer(() => historyStore.clearAll())
      return
    }
    await replaceHistory(async () => {})
  })

/**
 * 首次迁移：把旧版浏览器缓存（chat-demo 数据库）中的会话与附件上传到服务器。
 * 已存在的会话按 ID 跳过，不上传；返回实际上传的会话数。
 */
export const uploadLocalHistory = (): Promise<number> =>
  enqueueBackup(async () => {
    if (!SERVER_MODE) {
      return 0
    }
    const { sessions, files } = await db.loadLegacyHistory()
    if (sessions.length === 0) {
      return 0
    }
    const existing = new Set((await historyStore.loadSessionSummaries()).map((item) => item.id))
    let uploaded = 0
    await replaceHistoryFromServer(async () => {
      for (const session of sessions) {
        if (existing.has(session.id)) {
          continue
        }
        const fileIds = new Set(
          session.messages.flatMap((message) =>
            message.role === 'user' ? message.files.map((file) => file.id) : []
          )
        )
        const pending = [...fileIds].flatMap((id) => {
          const blob = files.get(id)
          return blob ? [{ id, blob }] : []
        })
        await historyStore.saveSession(session, pending)
        uploaded += 1
      }
    })
    return uploaded
  })
