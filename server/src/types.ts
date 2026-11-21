import type { Config } from './config.js'
import type { AppDatabase } from './db.js'

export type AuthUser = {
  id: string
  username: string
}

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDatabase
    config: Config
  }

  interface FastifyRequest {
    /** 由 requireUser 在认证通过后写入 */
    user: AuthUser | null
  }
}
