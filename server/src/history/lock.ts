import { HttpError } from '../http.js'

/** 同一用户的导入互斥；导入期间拒绝会话写入，避免事务交错。 */
const locks = new Set<string>()

export const isImporting = (userId: string) => locks.has(userId)

export const withImportLock = async <T>(userId: string, run: () => Promise<T>): Promise<T> => {
  if (locks.has(userId)) {
    throw new HttpError(409, 'import_in_progress', '历史数据正在导入，请稍后再试')
  }
  locks.add(userId)
  try {
    return await run()
  } finally {
    locks.delete(userId)
  }
}
