import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  createSessionToken,
  createUser,
  deleteSessionToken,
  findUserByUsername,
  hashPassword,
  requireUser,
  SESSION_COOKIE,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../auth.js'
import { HttpError } from '../http.js'
import type { AuthUser } from '../types.js'

type Credentials = {
  username: string
  password: string
}

const readCredentials = (body: unknown): Credentials => {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'invalid_request', '请求参数不合法')
  }
  const { username, password } = body as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'invalid_request', '请输入用户名和密码')
  }
  return { username: username.trim(), password }
}

const cookieOptions = (secure: boolean, maxAgeSeconds: number) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  maxAge: maxAgeSeconds,
})

export const authRoutes: FastifyPluginAsync = async (app) => {
  const login = async (reply: FastifyReply, user: AuthUser): Promise<AuthUser> => {
    const token = createSessionToken(app.db, user.id, app.config.sessionTtlMs)
    reply.setCookie(
      SESSION_COOKIE,
      token,
      cookieOptions(app.config.cookieSecure, Math.floor(app.config.sessionTtlMs / 1000))
    )
    return user
  }

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: app.config.loginRateMax,
          timeWindow: app.config.loginRateWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { username, password } = readCredentials(request.body)
      if (!username || username.length > 64 || password.length > 1024) {
        throw new HttpError(400, 'invalid_request', '用户名或密码不正确')
      }
      const row = findUserByUsername(app.db, username)
      if (!row || row.disabled !== 0 || !(await verifyPassword(password, row.password_hash))) {
        throw new HttpError(401, 'invalid_credentials', '用户名或密码不正确')
      }
      return { user: await login(reply, { id: row.id, username: row.username }) }
    }
  )

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) {
      deleteSessionToken(app.db, token)
    }
    reply.clearCookie(SESSION_COOKIE, cookieOptions(app.config.cookieSecure, 0))
    return { ok: true }
  })

  app.get('/me', { preHandler: requireUser }, async (request) => ({ user: request.user }))

  app.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: app.config.loginRateMax,
          timeWindow: app.config.loginRateWindowMs,
        },
      },
    },
    async (request, reply) => {
      if (!app.config.allowRegistration) {
        throw new HttpError(403, 'registration_disabled', '服务器未开放注册')
      }
      if (
        app.config.registrationCode &&
        (request.headers['x-registration-code'] ?? '') !== app.config.registrationCode
      ) {
        throw new HttpError(403, 'invalid_registration_code', '注册码不正确')
      }
      const { username, password } = readCredentials(request.body)
      if (!validateUsername(username)) {
        throw new HttpError(400, 'invalid_username', '用户名需为 3-32 位字母、数字、点、下划线或短横线')
      }
      if (!validatePassword(password)) {
        throw new HttpError(400, 'invalid_password', '密码至少 8 位')
      }
      const existing = findUserByUsername(app.db, username)
      if (existing) {
        throw new HttpError(409, 'username_taken', '用户名已存在')
      }
      const user = await createUser(app.db, username, password)
      return { user: await login(reply, user) }
    }
  )

  /** 修改密码：需要当前密码；成功后使其他设备上的旧令牌失效。 */
  app.post('/password', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user
    if (!user) {
      throw new HttpError(401, 'unauthorized', '登录已过期，请重新登录')
    }
    const body = request.body as Record<string, unknown> | null
    const current = body?.currentPassword
    const next = body?.newPassword
    if (typeof current !== 'string' || typeof next !== 'string' || !validatePassword(next)) {
      throw new HttpError(400, 'invalid_password', '新密码至少 8 位')
    }
    const row = findUserByUsername(app.db, user.username)
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      throw new HttpError(400, 'invalid_password', '当前密码不正确')
    }
    app.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(await hashPassword(next), user.id)
    app.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id)
    const token = createSessionToken(app.db, user.id, app.config.sessionTtlMs)
    reply.setCookie(
      SESSION_COOKIE,
      token,
      cookieOptions(app.config.cookieSecure, Math.floor(app.config.sessionTtlMs / 1000))
    )
    return { ok: true }
  })
}
