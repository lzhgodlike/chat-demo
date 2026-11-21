import { loadConfig } from './config.js'
import { buildServer } from './server.js'

const verifyApiKey = async (origin: string, apiKey: string, log: (message: string) => void) => {
  try {
    const response = await fetch(`${origin}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) {
      log(`DeepSeek API key check failed with HTTP ${response.status}`)
    }
  } catch (error) {
    log(`DeepSeek API key check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const main = async () => {
  const config = loadConfig()
  const app = await buildServer({ config })
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`chat-demo listening on http://${config.host}:${config.port}`)
  if (config.deepseekApiKey) {
    void verifyApiKey(config.deepseekApiOrigin, config.deepseekApiKey, (message) =>
      app.log.warn(message)
    )
  } else {
    app.log.warn('DEEPSEEK_API_KEY is not configured; /api/ai/* requests will fail')
  }

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    await app.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  // 启动失败时直接输出原因，PM2 日志可见。
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})
