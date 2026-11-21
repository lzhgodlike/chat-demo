import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { loadConfig, type Config } from './config.js'
import { clearAllImportStaging, openDatabase, type AppDatabase } from './db.js'
import { assertSameOrigin, errorBody, HttpError } from './http.js'
import './types.js'
import { authRoutes } from './routes/auth.js'
import { sessionRoutes } from './routes/sessions.js'
import { fileRoutes } from './routes/files.js'
import { historyRoutes } from './routes/history.js'
import { aiRoutes } from './routes/ai.js'

export type BuildServerOptions = {
  config?: Config
  db?: AppDatabase
  logger?: boolean
}

/** 构建 Fastify 实例，供生产启动与集成测试共用。 */
export const buildServer = async (options: BuildServerOptions = {}): Promise<FastifyInstance> => {
  const config = options.config ?? loadConfig()
  const ownsDb = options.db === undefined
  const db = options.db ?? openDatabase(config.databaseFile)
  if (ownsDb) {
    clearAllImportStaging(db)
  }

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: config.maxSessionBytes,
    logger: options.logger ?? (config.nodeEnv !== 'test' ? { level: 'info' } : false),
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      assertSameOrigin(request)
    }
  })

  // API 响应默认不进入浏览器 HTTP 缓存，附件除外（附件仍由前端按用户缓存）。
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.url.startsWith('/api/') &&
      reply.getHeader('cache-control') === undefined
    ) {
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(multipart, {
    limits: {
      fileSize: config.maxImportBytes,
      files: 1,
      fields: 10,
    },
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message))
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send(errorBody('payload_too_large', '上传内容超过大小限制'))
    }
    if (error.validation) {
      return reply.code(400).send(errorBody('invalid_request', '请求参数不合法'))
    }
    request.log.error({ err: error }, 'request failed')
    return reply
      .code(statusCode >= 400 && statusCode < 500 ? statusCode : 500)
      .send(errorBody('internal_error', '服务器内部错误'))
  })

  app.get('/api/health', async () => ({
    ok: true,
    aiConfigured: config.deepseekApiKey.length > 0,
  }))

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(sessionRoutes, { prefix: '/api/sessions' })
  await app.register(fileRoutes, { prefix: '/api/files' })
  await app.register(historyRoutes, { prefix: '/api/history' })
  await app.register(aiRoutes, { prefix: '/api/ai' })

  const indexFile = path.join(config.distDir, 'index.html')
  const hasFrontend = fs.existsSync(indexFile)
  if (hasFrontend) {
    await app.register(fastifyStatic, {
      root: config.distDir,
      wildcard: true,
      maxAge: '365d',
      immutable: true,
      setHeaders: (response, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          response.header('cache-control', 'no-cache')
        }
      },
    })
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send(errorBody('not_found', '接口不存在'))
    }
    if (hasFrontend && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send(errorBody('not_found', '页面不存在'))
  })

  if (ownsDb) {
    app.addHook('onClose', async () => {
      db.close()
    })
  }

  return app
}
