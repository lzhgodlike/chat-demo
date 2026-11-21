import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { requireUser } from '../auth.js'
import { consumeAiQuota } from '../aiQuota.js'
import { toArrayBuffer } from '../binary.js'
import { currentUser, errorBody, HttpError, readMultipartField } from '../http.js'
import type { Config } from '../config.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireApiKey = (config: Config): string => {
  if (!config.deepseekApiKey) {
    throw new HttpError(503, 'ai_not_configured', '服务器未配置 DeepSeek API Key')
  }
  return config.deepseekApiKey
}

const upstreamStatus = (status: number) => (status === 401 ? 400 : status)

const keyErrorText = () =>
  JSON.stringify(errorBody('ai_key_invalid', '服务器 API Key 无效或已过期，请联系管理员'))

const upstreamResponseText = async (response: Response) => {
  if (response.status === 401) {
    return keyErrorText()
  }
  return response.text().catch(() => '')
}

const readErrorText = async (response: Response) => {
  const text = await upstreamResponseText(response)
  if (text) {
    return text
  }
  return JSON.stringify(errorBody('upstream_error', '上游服务请求失败'))
}

/** 把上游字节流原样写入响应；客户端断开时由调用方 abort 上游。 */
const pipeResponse = async (
  reply: FastifyReply,
  response: Response,
  headers: Record<string, string>
) => {
  const body = response.body
  if (!body) {
    throw new HttpError(502, 'upstream_error', '上游服务没有返回内容')
  }
  reply.hijack()
  reply.raw.writeHead(200, headers)
  await pipeline(Readable.fromWeb(body as unknown as NodeWebReadableStream), reply.raw)
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser)

  /** SSE 聊天流：注入服务端 Key，原样转发事件流。 */
  app.post('/messages', async (request, reply) => {
    const user = currentUser(request)
    consumeAiQuota(user.id, app.config.aiRequestsPerMinute)
    const apiKey = requireApiKey(app.config)
    if (!isRecord(request.body)) {
      throw new HttpError(400, 'invalid_request', '请求参数不合法')
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    reply.raw.once('close', abort)
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': apiKey,
      }
      const beta = request.headers['anthropic-beta']
      if (typeof beta === 'string' && beta) {
        headers['anthropic-beta'] = beta
      }
      const upstream = await fetch(`${app.config.deepseekApiOrigin}/anthropic/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      if (!upstream.ok) {
        const text = await readErrorText(upstream)
        return reply
          .code(upstreamStatus(upstream.status))
          .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
          .send(text)
      }
      try {
        await pipeResponse(reply, upstream, {
          'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
      } catch (error) {
        if (!controller.signal.aborted && !reply.raw.destroyed) {
          request.log.warn({ err: error }, 'chat stream terminated')
          reply.raw.destroy()
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      if (reply.raw.headersSent) {
        reply.raw.destroy()
        return
      }
      throw error
    } finally {
      reply.raw.off('close', abort)
    }
  })

  /** 附件上传转发；purpose 必须在文件之前。 */
  app.post('/files', async (request, reply) => {
    const user = currentUser(request)
    consumeAiQuota(user.id, app.config.aiRequestsPerMinute)
    const apiKey = requireApiKey(app.config)
    const part = await request.file({
      limits: { fileSize: app.config.maxFileBytes, files: 1 },
    })
    if (!part) {
      throw new HttpError(400, 'missing_file', '没有收到文件')
    }
    const buffer = await part.toBuffer()
    if (part.file.truncated) {
      throw new HttpError(413, 'file_too_large', '附件超过大小限制')
    }
    const form = new FormData()
    const purpose = readMultipartField(part.fields, 'purpose')
    if (purpose) {
      form.append('purpose', purpose)
    }
    form.append(
      'file',
      new Blob([toArrayBuffer(buffer)], { type: part.mimetype || 'application/octet-stream' }),
      part.filename || 'file'
    )
    const upstream = await fetch(`${app.config.deepseekApiOrigin}/anthropic/v1/files`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: form,
    })
    return reply
      .code(upstreamStatus(upstream.status))
      .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
      .send(await upstreamResponseText(upstream))
  })

  /** 语音识别转发。 */
  app.post('/asr', async (request, reply) => {
    const user = currentUser(request)
    consumeAiQuota(user.id, app.config.aiRequestsPerMinute)
    const apiKey = requireApiKey(app.config)
    const part = await request.file({
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    })
    if (!part) {
      throw new HttpError(400, 'missing_file', '没有收到音频')
    }
    const buffer = await part.toBuffer()
    if (part.file.truncated) {
      throw new HttpError(413, 'file_too_large', '音频超过大小限制')
    }
    const form = new FormData()
    form.append(
      'file',
      new Blob([toArrayBuffer(buffer)], { type: part.mimetype || 'audio/wav' }),
      part.filename || 'recording.wav'
    )
    const upstream = await fetch(`${app.config.deepseekApiOrigin}/v1/tools/asr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    return reply
      .code(upstreamStatus(upstream.status))
      .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
      .send(await upstreamResponseText(upstream))
  })

  /** 语音合成转发：裸 PCM 字节流。 */
  app.post('/tts', async (request, reply) => {
    const user = currentUser(request)
    consumeAiQuota(user.id, app.config.aiRequestsPerMinute)
    const apiKey = requireApiKey(app.config)
    if (!isRecord(request.body)) {
      throw new HttpError(400, 'invalid_request', '请求参数不合法')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    reply.raw.once('close', abort)
    try {
      const upstream = await fetch(`${app.config.deepseekApiOrigin}/v1/tools/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      if (!upstream.ok) {
        return reply
          .code(upstreamStatus(upstream.status))
          .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
          .send(await readErrorText(upstream))
      }
      try {
        await pipeResponse(reply, upstream, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
      } catch (error) {
        if (!controller.signal.aborted && !reply.raw.destroyed) {
          request.log.warn({ err: error }, 'tts stream terminated')
          reply.raw.destroy()
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      if (reply.raw.headersSent) {
        reply.raw.destroy()
        return
      }
      throw error
    } finally {
      reply.raw.off('close', abort)
    }
  })
}
