import 'dotenv/config'
import path from 'node:path'

const int = (name: string, fallback: number, min = 1): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`)
  }
  return value
}

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

const origin = (name: string, fallback: string): string => {
  const raw = process.env[name]?.trim() || fallback
  return raw.replace(/\/+$/, '')
}

export type Config = {
  nodeEnv: string
  host: string
  port: number
  rootDir: string
  dataDir: string
  databaseFile: string
  distDir: string
  deepseekApiKey: string
  deepseekApiOrigin: string
  sessionTtlMs: number
  cookieSecure: boolean
  trustProxy: boolean
  allowRegistration: boolean
  registrationCode: string
  maxSessionBytes: number
  maxFileBytes: number
  maxImportBytes: number
  maxImportUncompressedBytes: number
  maxUserStorageBytes: number
  aiRequestsPerMinute: number
  loginRateMax: number
  loginRateWindowMs: number
}

/** 读取服务端配置；路径默认相对启动目录（PM2 请在项目根目录启动）。 */
export const loadConfig = (): Config => {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const rootDir = path.resolve(process.env.APP_ROOT ?? process.cwd())
  const dataDir = path.resolve(rootDir, process.env.DATA_DIR ?? 'data')
  const mib = 1024 * 1024
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? ''

  return {
    nodeEnv,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: int('PORT', 8080),
    rootDir,
    dataDir,
    databaseFile: path.join(dataDir, 'chat-demo.sqlite'),
    distDir: path.resolve(rootDir, process.env.DIST_DIR ?? 'dist'),
    deepseekApiKey,
    deepseekApiOrigin: origin('DEEPSEEK_API_ORIGIN', 'https://api.deepseek.com'),
    sessionTtlMs: int('SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
    // 默认在 production 下要求 HTTPS；反向代理终止 TLS 时保持开启即可。
    cookieSecure: bool('COOKIE_SECURE', nodeEnv === 'production'),
    trustProxy: bool('TRUST_PROXY', false),
    allowRegistration: bool('ALLOW_REGISTRATION', false),
    registrationCode: process.env.REGISTRATION_CODE?.trim() ?? '',
    maxSessionBytes: int('MAX_SESSION_MB', 32) * mib,
    maxFileBytes: int('MAX_FILE_MB', 64) * mib,
    maxImportBytes: int('MAX_IMPORT_MB', 512) * mib,
    maxImportUncompressedBytes: int('MAX_IMPORT_UNCOMPRESSED_MB', 2048) * mib,
    maxUserStorageBytes: int('MAX_USER_STORAGE_MB', 2048) * mib,
    aiRequestsPerMinute: int('AI_REQUESTS_PER_MINUTE', 30),
    loginRateMax: int('LOGIN_RATE_MAX', 10),
    loginRateWindowMs: int('LOGIN_RATE_WINDOW_MINUTES', 10) * 60 * 1000,
  }
}
