import type { AppDatabase } from '../db.js'
import { toArrayBuffer } from '../binary.js'
import { buildArchive } from '../../../src/services/chat/history/archiveBuilder.js'
import type { Session } from '../../../src/services/chat/types.js'

/** 从 SQLite 读取用户全部会话与图片，生成官方 v3 归档。 */
export const exportUserArchive = async (db: AppDatabase, userId: string): Promise<Blob> => {
  const rows = db
    .prepare('SELECT data FROM sessions WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as { data: string }[]
  const sessions = rows.map((row) => JSON.parse(row.data) as Session)
  return buildArchive(sessions, async (id) => {
    const row = db
      .prepare('SELECT mime_type, data FROM files WHERE user_id = ? AND id = ?')
      .get(userId, id) as { mime_type: string; data: Buffer } | undefined
    return row ? new Blob([toArrayBuffer(row.data)], { type: row.mime_type }) : undefined
  })
}
