import { createInterface } from 'node:readline/promises'
import { loadConfig } from '../config.js'
import { openDatabase } from '../db.js'
import {
  createUser,
  findUserByUsername,
  hashPassword,
  validatePassword,
  validateUsername,
} from '../auth.js'

const usage = `用法：
  server:user add <username> [password]
  server:user passwd <username> [password]
  server:user disable <username>
  server:user enable <username>
  server:user delete <username>
  server:user list`

const readPassword = async (): Promise<string> => {
  if (process.env.CHAT_DEMO_PASSWORD) {
    return process.env.CHAT_DEMO_PASSWORD
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question('Password (visible): ')
  } finally {
    rl.close()
  }
}

const main = async () => {
  const [command, username, passwordArg] = process.argv.slice(2)
  if (!command) {
    // eslint-disable-next-line no-console
    console.log(usage)
    process.exit(1)
  }
  const config = loadConfig()
  const db = openDatabase(config.databaseFile)
  try {
    if (command === 'list') {
      const rows = db
        .prepare('SELECT id, username, created_at, disabled FROM users ORDER BY username')
        .all() as { id: string; username: string; created_at: number; disabled: number }[]
      for (const row of rows) {
        // eslint-disable-next-line no-console
        console.log(
          `${row.username}\t${row.disabled ? 'disabled' : 'active'}\t${new Date(row.created_at).toISOString()}\t${row.id}`
        )
      }
      return
    }
    if (!username) {
      throw new Error('缺少用户名')
    }
    const existing = findUserByUsername(db, username)
    if (command === 'add') {
      if (!validateUsername(username)) {
        throw new Error('用户名需为 3-32 位字母、数字、点、下划线或短横线')
      }
      if (existing) {
        throw new Error('用户名已存在')
      }
      const password = passwordArg ?? (await readPassword())
      if (!validatePassword(password)) {
        throw new Error('密码至少 8 位')
      }
      const user = await createUser(db, username, password)
      // eslint-disable-next-line no-console
      console.log(`created ${user.username} (${user.id})`)
      return
    }
    if (!existing) {
      throw new Error(`用户不存在：${username}`)
    }
    if (command === 'passwd') {
      const password = passwordArg ?? (await readPassword())
      if (!validatePassword(password)) {
        throw new Error('密码至少 8 位')
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        await hashPassword(password),
        existing.id
      )
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id)
      // eslint-disable-next-line no-console
      console.log(`password updated for ${existing.username}`)
      return
    }
    if (command === 'disable' || command === 'enable') {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(
        command === 'disable' ? 1 : 0,
        existing.id
      )
      if (command === 'disable') {
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id)
      }
      // eslint-disable-next-line no-console
      console.log(`${command}d ${existing.username}`)
      return
    }
    if (command === 'delete') {
      db.prepare('DELETE FROM users WHERE id = ?').run(existing.id)
      // eslint-disable-next-line no-console
      console.log(`deleted ${existing.username}`)
      return
    }
    // eslint-disable-next-line no-console
    console.log(usage)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
