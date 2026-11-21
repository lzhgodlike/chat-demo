import { useEffect } from 'react'
import { LoginPage } from '../components/auth/LoginPage.js'
import { translate, useTranslate } from '../i18n/index.js'
import { checkAuth, useAuth } from '../services/auth.js'
import { initChat, resetChat } from '../services/chat/store.js'
import { configureHistoryUser } from '../services/chat/storage.js'
import { SERVER_MODE } from '../services/runtime.js'
import { App } from './App.js'
import styles from './Root.module.css'

const ServerApp = () => {
  const t = useTranslate()
  const status = useAuth((state) => state.status)
  const userId = useAuth((state) => state.user?.id)

  useEffect(() => {
    void checkAuth()
  }, [])

  useEffect(() => {
    const onUnauthorized = () => {
      resetChat()
      configureHistoryUser(null)
      useAuth.setState({
        status: 'anonymous',
        user: null,
        error: translate('loginExpired'),
      })
    }
    window.addEventListener('chat-demo:unauthorized', onUnauthorized)
    return () => window.removeEventListener('chat-demo:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    if (status === 'authenticated' && userId) {
      configureHistoryUser(userId)
      void initChat()
    } else if (status === 'anonymous') {
      resetChat()
    }
  }, [status, userId])

  if (status === 'checking') {
    return (
      <div className={styles.loading} role="status" aria-live="polite">
        {t('sessionLoading')}
      </div>
    )
  }
  if (status === 'anonymous') {
    return <LoginPage />
  }
  return <App />
}

/** 入口：静态版直接渲染 App；服务器版先完成登录再初始化聊天。 */
export const Root = () => (SERVER_MODE ? <ServerApp /> : <App />)
