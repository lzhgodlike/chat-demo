import { useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useAuth, login } from '../../services/auth.js'
import { setLocale, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './LoginPage.module.css'

/** 服务器模式的登录页：账号由管理员创建，登录后进入聊天。 */
export const LoginPage = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const error = useAuth((state) => state.error)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !username.trim() || !password) {
      return
    }
    setBusy(true)
    try {
      await login(username.trim(), password)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.appName}>{t('appName')}</div>
          <button
            type="button"
            className={styles.locale}
            onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
          >
            {locale === 'zh-CN' ? 'English' : '中文'}
          </button>
        </div>
        <h1 className={styles.title}>{t('loginTitle')}</h1>
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label className={styles.field}>
            <span>{t('loginUsername')}</span>
            <input
              className={styles.input}
              value={username}
              autoComplete="username"
              autoFocus
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('loginPassword')}</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
          <Button type="submit" block disabled={busy || !username.trim() || !password}>
            {busy ? t('loginSubmitting') : t('loginSubmit')}
          </Button>
        </form>
        <p className={styles.hint}>{t('loginHint')}</p>
      </div>
    </div>
  )
}
