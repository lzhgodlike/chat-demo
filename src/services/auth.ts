import { create } from 'zustand'
import { translate } from '../i18n/index.js'
import { resetChat } from './chat/store.js'
import { configureHistoryUser } from './chat/storage.js'
import { SERVER_MODE } from './runtime.js'

export type AuthUser = {
  id: string
  username: string
}

type AuthState = {
  status: 'checking' | 'anonymous' | 'authenticated'
  user: AuthUser | null
  error: string | null
}

export const useAuth = create<AuthState>(() => ({
  status: SERVER_MODE ? 'checking' : 'authenticated',
  user: null,
  error: null,
}))

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') {
      return body.error.message
    }
  } catch {
    // 非 JSON 错误体使用状态文本。
  }
  return response.statusText || `HTTP ${response.status}`
}

export const checkAuth = async (): Promise<void> => {
  if (!SERVER_MODE) {
    return
  }
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
    if (response.status === 401) {
      useAuth.setState({ status: 'anonymous', user: null, error: null })
      return
    }
    if (!response.ok) {
      useAuth.setState({
        status: 'anonymous',
        user: null,
        error: await readErrorMessage(response),
      })
      return
    }
    const body = (await response.json()) as { user: AuthUser }
    useAuth.setState({ status: 'authenticated', user: body.user, error: null })
  } catch {
    useAuth.setState({
      status: 'anonymous',
      user: null,
      error: translate('serverUnreachable'),
    })
  }
}

export const login = async (username: string, password: string): Promise<boolean> => {
  useAuth.setState({ error: null })
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) {
      useAuth.setState({ error: await readErrorMessage(response) })
      return false
    }
    const body = (await response.json()) as { user: AuthUser }
    useAuth.setState({ status: 'authenticated', user: body.user, error: null })
    return true
  } catch {
    useAuth.setState({ error: translate('serverUnreachable') })
    return false
  }
}

export const logout = async (): Promise<void> => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    // 服务端不可达时仍退出本地状态。
  }
  resetChat()
  configureHistoryUser(null)
  useAuth.setState({ status: 'anonymous', user: null, error: null })
}
