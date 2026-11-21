import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { zipSync } from 'fflate'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'
import { openDatabase, type AppDatabase } from '../src/db.js'
import { createUser } from '../src/auth.js'
import type { Session } from '../../src/services/chat/types.js'

const testConfig = (overrides: Partial<Config> = {}): Config => ({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  rootDir: process.cwd(),
  dataDir: process.cwd(),
  databaseFile: ':memory:',
  distDir: `${process.cwd()}/does-not-exist`,
  deepseekApiKey: 'test-key',
  deepseekApiOrigin: 'http://127.0.0.1:1',
  sessionTtlMs: 60 * 60 * 1000,
  cookieSecure: false,
  trustProxy: false,
  allowRegistration: false,
  registrationCode: '',
  maxSessionBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxImportBytes: 16 * 1024 * 1024,
  maxImportUncompressedBytes: 64 * 1024 * 1024,
  maxUserStorageBytes: 32 * 1024 * 1024,
  aiRequestsPerMinute: 1000,
  loginRateMax: 100,
  loginRateWindowMs: 60_000,
  ...overrides,
})

const sessionOf = (id: string, withFile = false): Session => {
  const now = Date.now()
  return {
    id,
    title: `title-${id}`,
    createdAt: now,
    updatedAt: now,
    rootMessageId: 'm1',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'hello',
        createdAt: now,
        parentId: null,
        selectedChildId: 'm2',
        files: withFile
          ? [
              {
                id: 'file1',
                serverId: null,
                name: 'a.png',
                size: 68,
                isImage: true,
                mimeType: 'image/png',
              },
            ]
          : [],
      },
      {
        id: 'm2',
        role: 'assistant',
        createdAt: now,
        parentId: 'm1',
        model: null,
        thinking: false,
        search: false,
        prefix: false,
        status: 'done',
        blocks: [{ type: 'text', text: 'world' }],
      },
    ],
  }
}

const multipart = (
  filename: string,
  data: Uint8Array,
  fields: Record<string, string> = {},
  contentType = 'application/octet-stream'
) => {
  const boundary = `----chatdemo${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    )
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    )
  )
  chunks.push(Buffer.from(data))
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=',
  'base64'
)

const iso = new Date().toISOString()

const fixtureZip = () => {
  const session = {
    id: 's1',
    title: 'imported',
    pinned: false,
    current_message_id: 2,
    inserted_at: iso,
    updated_at: iso,
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        thinking_enabled: false,
        search_enabled: false,
        accumulated_token_usage: 0,
        inserted_at: iso,
        fragments: [
          {
            type: 'FILE',
            files: [
              {
                id: 'img1',
                file_name: 'a.png',
                file_size: png.byteLength,
                token_usage: null,
                inserted_at: iso,
                export_path: 'chat_sessions/s1_files/img1_a.png',
                is_image: true,
                width: 1,
                height: 1,
              },
            ],
          },
          { type: 'REQUEST', content: 'hi' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        thinking_enabled: false,
        search_enabled: false,
        accumulated_token_usage: 0,
        inserted_at: iso,
        fragments: [{ type: 'RESPONSE', content: 'hello' }],
      },
    ],
  }
  const index = [
    {
      id: 's1',
      title: 'imported',
      pinned: false,
      message_count: 2,
      inserted_at: iso,
      updated_at: iso,
    },
  ]
  return zipSync({
    'manifest.json': new TextEncoder().encode(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/s1.json': new TextEncoder().encode(JSON.stringify(session)),
    'chat_session_index.json': new TextEncoder().encode(JSON.stringify(index)),
    'chat_sessions/s1_files/img1_a.png': png,
  })
}

let app: FastifyInstance
let db: AppDatabase
let cookie: string
let upstream: FastifyInstance
let upstreamKey = ''

before(async () => {
  db = openDatabase(':memory:')
  upstream = Fastify()
  upstream.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  )
  upstream.post('/anthropic/v1/messages', async (request, reply) => {
    upstreamKey = String(request.headers['x-api-key'] ?? '')
    return reply
      .header('content-type', 'text/event-stream')
      .send('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  upstream.post('/anthropic/v1/files', async (request, reply) => {
    upstreamKey = String(request.headers['x-api-key'] ?? '')
    return reply
      .header('content-type', 'application/json')
      .send(JSON.stringify({ id: 'file-uploaded', size_bytes: Buffer.byteLength(request.body as Buffer) }))
  })
  upstream.post('/v1/tools/asr', async (request, reply) => {
    upstreamKey = String(request.headers.authorization ?? '')
    return reply.header('content-type', 'application/json').send('{"text":"transcribed"}')
  })
  upstream.post('/v1/tools/tts', async (request, reply) => {
    upstreamKey = String(request.headers.authorization ?? '')
    return reply
      .header('content-type', 'application/octet-stream')
      .send(Buffer.from([1, 2, 3, 4]))
  })
  await upstream.listen({ host: '127.0.0.1', port: 0 })
  const address = upstream.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  app = await buildServer({
    config: testConfig({ deepseekApiOrigin: `http://127.0.0.1:${port}` }),
    db,
    logger: false,
  })
  await app.ready()
  await createUser(db, 'alice', 'password123')
  await createUser(db, 'bob', 'password123')
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'password123' },
  })
  assert.equal(login.statusCode, 200)
  cookie = String(login.headers['set-cookie']).split(';')[0]
})

after(async () => {
  await app.close()
  await upstream.close()
  db.close()
})

test('requires authentication', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/sessions' })
  assert.equal(response.statusCode, 401)
})

test('session CRUD, revisions and isolation', async () => {
  const session = sessionOf('s1')
  let response = await app.inject({
    method: 'PUT',
    url: '/api/sessions/s1',
    headers: { cookie },
    payload: { session },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().revision, 1)

  response = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { cookie },
  })
  assert.deepEqual(
    response.json().map((item: { id: string }) => item.id),
    ['s1']
  )

  response = await app.inject({
    method: 'GET',
    url: '/api/sessions/s1',
    headers: { cookie },
  })
  assert.equal(response.json().session.title, 'title-s1')
  assert.equal(response.json().revision, 1)

  response = await app.inject({
    method: 'PUT',
    url: '/api/sessions/s1',
    headers: { cookie },
    payload: { session: { ...session, title: 'changed' }, baseRevision: 0 },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(response.json().revision, 1)

  response = await app.inject({
    method: 'PATCH',
    url: '/api/sessions/s1',
    headers: { cookie },
    payload: { title: 'renamed' },
  })
  assert.equal(response.statusCode, 200)

  response = await app.inject({
    method: 'GET',
    url: '/api/sessions/s1',
    headers: { cookie },
  })
  assert.equal(response.json().session.title, 'renamed')

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob', password: 'password123' },
  })
  const bobCookie = String(login.headers['set-cookie']).split(';')[0]
  response = await app.inject({
    method: 'GET',
    url: '/api/sessions/s1',
    headers: { cookie: bobCookie },
  })
  assert.equal(response.statusCode, 404)
})

test('file upload and download with ownership', async () => {
  const form = multipart('a.png', png, { name: 'a.png', mimeType: 'image/png' }, 'image/png')
  let response = await app.inject({
    method: 'PUT',
    url: '/api/files/file1',
    headers: { cookie, 'content-type': form.contentType },
    payload: form.body,
  })
  assert.equal(response.statusCode, 200)

  response = await app.inject({
    method: 'GET',
    url: '/api/files/file1',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.deepEqual(response.rawPayload, png)

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob', password: 'password123' },
  })
  const bobCookie = String(login.headers['set-cookie']).split(';')[0]
  response = await app.inject({
    method: 'GET',
    url: '/api/files/file1',
    headers: { cookie: bobCookie },
  })
  assert.equal(response.statusCode, 404)
})

test('imports official ZIP, merges duplicates and exports', async () => {
  const zip = fixtureZip()
  const form = multipart('deepseek_data.zip', zip, {}, 'application/zip')
  let response = await app.inject({
    method: 'POST',
    url: '/api/history/import?mode=replace',
    headers: { cookie, 'content-type': form.contentType },
    payload: form.body,
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { sessions: 1, files: 1, skipped: 0 })

  response = await app.inject({
    method: 'GET',
    url: '/api/sessions/s1',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().session.title, 'imported')
  assert.equal(response.json().session.messages.length, 2)

  response = await app.inject({
    method: 'GET',
    url: '/api/files/img1',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.rawPayload, png)

  response = await app.inject({
    method: 'POST',
    url: '/api/history/import?mode=merge',
    headers: { cookie, 'content-type': form.contentType },
    payload: form.body,
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { sessions: 0, files: 1, skipped: 1 })

  response = await app.inject({
    method: 'GET',
    url: '/api/history/export',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['content-type']), /application\/zip/)
  assert.equal(response.rawPayload[0], 0x50)
  assert.equal(response.rawPayload[1], 0x4b)

  // 导出的 ZIP 必须能再次被导入（合并模式会跳过已存在的 s1）。
  const exported = multipart('deepseek_data.zip', response.rawPayload, {}, 'application/zip')
  response = await app.inject({
    method: 'POST',
    url: '/api/history/import?mode=merge',
    headers: { cookie, 'content-type': exported.contentType },
    payload: exported.body,
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { sessions: 0, files: 1, skipped: 1 })
})

test('rejects invalid archives', async () => {
  const form = multipart('bad.zip', Buffer.from('not a zip'), {}, 'application/zip')
  const response = await app.inject({
    method: 'POST',
    url: '/api/history/import',
    headers: { cookie, 'content-type': form.contentType },
    payload: form.body,
  })
  assert.equal(response.statusCode, 400)
})

test('proxies chat SSE with the server key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai/messages',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { model: 'deepseek-flash', stream: true, messages: [] },
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(upstreamKey, 'test-key')
  assert.match(response.body, /message_stop/)
})

test('proxies file upload, ASR and TTS', async () => {
  const fileForm = multipart(
    'a.png',
    png,
    { purpose: 'user_data' },
    'image/png'
  )
  let response = await app.inject({
    method: 'POST',
    url: '/api/ai/files',
    headers: { cookie, 'content-type': fileForm.contentType },
    payload: fileForm.body,
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(upstreamKey, 'test-key')
  assert.equal(response.json().id, 'file-uploaded')

  const audioForm = multipart('recording.wav', Buffer.from([1, 2, 3]), {}, 'audio/wav')
  response = await app.inject({
    method: 'POST',
    url: '/api/ai/asr',
    headers: { cookie, 'content-type': audioForm.contentType },
    payload: audioForm.body,
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().text, 'transcribed')
  assert.equal(upstreamKey, 'Bearer test-key')

  response = await app.inject({
    method: 'POST',
    url: '/api/ai/tts',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { text: 'hello', voice_id: 'stella', format: 'pcm', filter_markdown: true },
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.rawPayload, Buffer.from([1, 2, 3, 4]))
})

test('clears all sessions and files', async () => {
  const response = await app.inject({
    method: 'DELETE',
    url: '/api/sessions',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } })
  assert.deepEqual(list.json(), [])
  const file = await app.inject({ method: 'GET', url: '/api/files/img1', headers: { cookie } })
  assert.equal(file.statusCode, 404)
})
