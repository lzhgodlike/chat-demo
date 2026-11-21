import { SERVER_MODE } from '../runtime.js'
import * as db from './db.js'
import type { StoredFile } from './db.js'
import type { Session, SessionSummary } from './types.js'

export type { StoredFile }

export class HistoryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HistoryRequestError'
  }
}

export class HistoryConflictError extends HistoryRequestError {}

export type HistoryStore = {
  loadSessionSummaries(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session, files?: StoredFile[]): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  deleteSession(id: string): Promise<void>
  loadFile(id: string): Promise<Blob | undefined>
  saveFiles(files: StoredFile[]): Promise<void>
  clearAll(): Promise<void>
  /** 等待所有在途保存结束，导入/清空等整体操作前调用。 */
  waitForIdle(): Promise<void>
}

const report = db.reportStorageError

const localStore: HistoryStore = {
  loadSessionSummaries: db.loadSessionSummaries,
  loadSession: db.loadSession,
  saveSession: db.saveSession,
  renameSession: db.renameSession,
  deleteSession: db.deleteSession,
  loadFile: db.loadFile,
  saveFiles: db.saveFiles,
  clearAll: db.clearLocalHistory,
  waitForIdle: () => Promise.resolve(),
}

const readError = async (response: Response) => {
  if (response.status === 401) {
    window.dispatchEvent(new Event('chat-demo:unauthorized'))
  }
  let code = 'request_failed'
  let message = response.statusText || `HTTP ${response.status}`
  let revision: number | undefined
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown }
      revision?: unknown
    }
    if (typeof body.error?.code === 'string') {
      code = body.error.code
    }
    if (typeof body.error?.message === 'string') {
      message = body.error.message
    }
    if (typeof body.revision === 'number') {
      revision = body.revision
    }
  } catch {
    // 非 JSON 错误体沿用状态文本。
  }
  const ErrorClass = response.status === 409 ? HistoryConflictError : HistoryRequestError
  const error = new ErrorClass(response.status, code, message)
  if (response.status === 409 && revision !== undefined) {
    return Object.assign(error, { revision })
  }
  return error
}

const requestJson = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    throw await readError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

const fileMetadata = (session: Session) => {
  const meta = new Map<string, { name: string; mimeType: string }>()
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      meta.set(file.id, { name: file.name, mimeType: file.mimeType })
    }
  }
  return meta
}

const uploadStoredFile = async (
  file: StoredFile,
  meta: { name: string; mimeType: string } | undefined
) => {
  const name = meta?.name || file.id
  const form = new FormData()
  form.append('name', name)
  form.append('mimeType', meta?.mimeType || file.blob.type)
  form.append('file', file.blob, name)
  await requestJson(`/api/files/${encodeURIComponent(file.id)}`, {
    method: 'PUT',
    body: form,
  })
}

const createRemoteStore = (): HistoryStore => {
  const revisions = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()

  const queued = (id: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    const tracked = next.finally(() => {
      if (queues.get(id) === tracked) {
        queues.delete(id)
      }
    })
    queues.set(id, tracked)
    return tracked
  }

  const save = async (session: Session, files: StoredFile[]) => {
    // 本地缓存是加速与弱网兜底，失败不阻断服务器保存。
    await db.saveSession(session, files).catch(report('save local cache'))
    if (files.length > 0) {
      const meta = fileMetadata(session)
      await Promise.all(files.map((file) => uploadStoredFile(file, meta.get(file.id))))
    }
    const baseRevision = revisions.get(session.id)
    try {
      const result = await requestJson<{ revision: number }>(
        `/api/sessions/${encodeURIComponent(session.id)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, ...(baseRevision === undefined ? {} : { baseRevision }) }),
        }
      )
      revisions.set(session.id, result.revision)
    } catch (error) {
      if (error instanceof HistoryConflictError) {
        const revision = (error as HistoryConflictError & { revision?: number }).revision
        if (typeof revision === 'number') {
          // 记录服务器版本，用户点击重试时按最新版本覆盖，避免永久冲突。
          revisions.set(session.id, revision)
        }
      }
      throw error
    }
  }

  return {
    async loadSessionSummaries() {
      try {
        const summaries = await requestJson<SessionSummary[]>('/api/sessions')
        void db.replaceSessionSummaries(summaries).catch(report('cache session summaries'))
        return summaries
      } catch (error) {
        if (error instanceof HistoryRequestError && error.status === 401) {
          throw error
        }
        const cached = await db.loadSessionSummaries()
        if (cached.length > 0) {
          return cached
        }
        throw error
      }
    },

    async loadSession(id) {
      try {
        const result = await requestJson<{ session: Session; revision: number }>(
          `/api/sessions/${encodeURIComponent(id)}`
        )
        revisions.set(id, result.revision)
        void db.saveSession(result.session).catch(report('cache session'))
        return result.session
      } catch (error) {
        if (error instanceof HistoryRequestError && error.status === 404) {
          await db.deleteSession(id).catch(report('drop cached session'))
          revisions.delete(id)
          return undefined
        }
        if (error instanceof HistoryRequestError && error.status === 401) {
          throw error
        }
        return db.loadSession(id)
      }
    },

    saveSession(session, files = []) {
      return queued(session.id, () => save(session, files))
    },

    async renameSession(id, title) {
      await requestJson(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      await db.renameSession(id, title).catch(report('rename cached session'))
    },

    async deleteSession(id) {
      // 等该会话在途的保存结束，避免 DELETE 之后又被一个迟到的 PUT 重新创建。
      await queues.get(id)?.catch(() => {})
      await requestJson(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      revisions.delete(id)
      queues.delete(id)
      await db.deleteSession(id).catch(report('delete cached session'))
    },

    async loadFile(id) {
      const cached = await db.loadFile(id)
      if (cached) {
        return cached
      }
      const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) {
        if (response.status === 404) {
          return undefined
        }
        throw await readError(response)
      }
      const blob = await response.blob()
      void db.saveFiles([{ id, blob }]).catch(report('cache file'))
      return blob
    },

    async saveFiles(files) {
      await db.saveFiles(files).catch(report('save local files'))
      await Promise.all(files.map((file) => uploadStoredFile(file, undefined)))
    },

    async clearAll() {
      // 清空同样要等所有在途保存结束，避免删除后又被写回。
      await Promise.all([...queues.values()].map((task) => task.catch(() => {})))
      await requestJson('/api/sessions', { method: 'DELETE' })
      revisions.clear()
      queues.clear()
      await db.clearLocalHistory().catch(report('clear local cache'))
    },

    async waitForIdle() {
      await Promise.all([...queues.values()].map((task) => task.catch(() => {})))
    },
  }
}

export const historyStore: HistoryStore = SERVER_MODE ? createRemoteStore() : localStore

/** 服务器模式按用户隔离 IndexedDB 缓存；本地模式始终使用 chat-demo。 */
export const configureHistoryUser = (userId: string | null) => {
  db.configureDatabase(SERVER_MODE && userId ? `chat-demo-u-${userId}` : 'chat-demo')
}

export type ImportMode = 'replace' | 'merge'

export type ServerImportResult = {
  sessions: number
  files: number
  skipped: number
}

/** 上传官方导出 ZIP 到服务器。 */
export const importHistoryToServer = async (
  file: File,
  mode: ImportMode
): Promise<ServerImportResult> => {
  const form = new FormData()
  form.append('file', file, file.name)
  return requestJson<ServerImportResult>(`/api/history/import?mode=${mode}`, {
    method: 'POST',
    body: form,
  })
}

/** 下载服务器生成的官方格式 ZIP。 */
export const exportHistoryFromServer = async (): Promise<{ name: string; blob: Blob }> => {
  const response = await fetch('/api/history/export', { credentials: 'same-origin' })
  if (!response.ok) {
    throw await readError(response)
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'deepseek_data.zip'
  return { name, blob: await response.blob() }
}
