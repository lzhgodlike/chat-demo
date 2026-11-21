import * as db from '../db.js'
import type { Session } from '../types.js'
import { buildArchive } from './archiveBuilder.js'

/** 浏览器端导出：图片原件来自 IndexedDB。 */
export const exportArchive = (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => buildArchive(sessions, db.loadFile)
