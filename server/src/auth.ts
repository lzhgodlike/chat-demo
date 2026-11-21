import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppDatabase, UserRow } from './db.js'
import { errorBody } from './http.js'
import type { AuthUser } from './types.js'

export const SESSION_COOKIE = 'chat_demo_session'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const scrypt = (password: string, salt: Buffer, options: ScryptOptions, keyLength: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) {
        reject(error)
      } else {
        resolve(key)
      }
    })
  })

/** 存储格式：scrypt$N$r$p$salt(base64)$key(base64)。 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scrypt(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, KEY_LENGTH)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, n, r, p, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) {
    return false
  }
  const N = Number(n)
  const rr = Number(r)
  const pp = Number(p)
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(rr) || !Number.isSafeInteger(pp)) {
    return false
  }
  const expected = Buffer.from(key, 'base64')
  if (expected.length === 0) {
    return false
  }
  try {
    const actual = await scrypt(
      password,
      Buffer.from(salt, 'base64'),
      { N, r: rr, p: pp, maxmem: 128 * N * rr * 2 + 1024 * 1024 },
      expected.length
    )
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export const validateUsername = (username: string): boolean =>
  /^[A-Za-z0-9_.-]{3,32}$/.test(username)

export const validatePassword = (password: string): boolean => password.length >= 8

export const createUser = async (
  db: AppDatabase,
  username: string,
  password: string
): Promise<AuthUser> => {
  const user: AuthUser = { id: randomBytes(16).toString('hex'), username }
  db.prepare(
    'INSERT INTO users (id, username, password_hash, created_at, disabled) VALUES (?, ?, ?, ?, 0)'
  ).run(user.id, username, await hashPassword(password), Date.now())
  return user
}

export const findUserByUsername = (db: AppDatabase, username: string): UserRow | undefined =>
  db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as
    | UserRow
    | undefined

export const findUserById = (db: AppDatabase, id: string): UserRow | undefined =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined

/** 创建登录令牌；返回明文令牌，数据库只保存哈希。 */
export const createSessionToken = (db: AppDatabase, userId: string, ttlMs: number): string => {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256(token), userId, now, now + ttlMs)
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now)
  return token
}

export const deleteSessionToken = (db: AppDatabase, token: string) => {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token))
}

export const findUserByToken = (db: AppDatabase, token: string): AuthUser | undefined => {
  const row = db
    .prepare(
      `SELECT users.id, users.username
         FROM auth_sessions
         JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = ?
          AND auth_sessions.expires_at > ?
          AND users.disabled = 0`
    )
    .get(sha256(token), Date.now()) as AuthUser | undefined
  return row
}

/** 路由前置钩子：读取 Cookie，把用户挂到 request 上，未登录直接 401。 */
export const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
  const token = request.cookies[SESSION_COOKIE]
  const user = token ? findUserByToken(request.server.db, token) : undefined
  if (!user) {
    await reply.code(401).send(errorBody('unauthorized', '登录已过期，请重新登录'))
    return
  }
  request.user = user
}
