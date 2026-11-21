import { HttpError } from './http.js'

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** 简单的每分钟用户请求配额；单实例内存计数，重启后清零。 */
export const consumeAiQuota = (userId: string, limit: number) => {
  if (limit <= 0) {
    return
  }
  const now = Date.now()
  const bucket = buckets.get(userId)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(userId, { count: 1, resetAt: now + 60_000 })
    if (buckets.size > 10_000) {
      for (const [key, value] of buckets) {
        if (value.resetAt <= now) {
          buckets.delete(key)
        }
      }
    }
    return
  }
  if (bucket.count >= limit) {
    throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试')
  }
  bucket.count += 1
}
