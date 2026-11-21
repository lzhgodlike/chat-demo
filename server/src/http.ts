import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUser } from './types.js'

export type ApiErrorBody = {
  error: {
    code: string
    message: string
  }
}

export const errorBody = (code: string, message: string): ApiErrorBody => ({
  error: { code, message },
})

/** 业务错误：抛出后由全局错误处理器转换为统一 JSON。 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const currentUser = (request: FastifyRequest): AuthUser => {
  if (!request.user) {
    throw new HttpError(401, 'unauthorized', '请先登录')
  }
  return request.user
}

export const assertSameOrigin = (request: FastifyRequest) => {
  const site = request.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'cross_site_request', '拒绝跨站请求')
  }
  const origin = request.headers.origin
  if (origin) {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      throw new HttpError(403, 'invalid_origin', '请求来源不合法')
    }
    if (host !== request.headers.host) {
      throw new HttpError(403, 'cross_site_request', '拒绝跨站请求')
    }
  }
}

export const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send(errorBody(code, message))

/** 读取 multipart 中位于文件之前的普通字段。 */
export const readMultipartField = (fields: unknown, key: string): string | undefined => {
  if (typeof fields !== 'object' || fields === null) {
    return undefined
  }
  const field = (fields as Record<string, unknown>)[key]
  if (typeof field !== 'object' || field === null || !('value' in field)) {
    return undefined
  }
  const value = (field as { value: unknown }).value
  return typeof value === 'string' ? value : undefined
}
