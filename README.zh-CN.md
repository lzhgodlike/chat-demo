# chat-demo

[English](README.md) | 简体中文

> **一句话简介：** 基于 DeepSeek API 的聊天应用示例，既能作为纯静态网页直接运行，也能切换为带账号登录和服务器端会话存储的多用户版本。

chat-demo 演示了 DeepSeek Anthropic 兼容 Messages / Files API 的完整聊天体验：流式回答、深度思考、智能搜索、来源引用、附件、语音和消息分支。默认构建是纯静态站点；可选的服务器模式使用 Fastify + SQLite，把会话、附件原件和 API Key 都放到服务器端，并支持导入/导出 DeepSeek 官方数据包。

## 功能亮点

- 多会话、自动标题、重命名与删除；编辑提问、重新生成、继续生成和消息分支切换。
- 流式回答、深度思考、智能搜索、链接阅读和来源引用。
- 附件上传、粘贴与拖拽，语音输入和回复朗读。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表；中英文界面、浅色/深色主题、移动端布局。
- 支持 DeepSeek 官方 `deepseek_data-YYYY-MM-DD.zip`（v3）导入/导出；服务器模式支持覆盖或合并。
- 可选服务器模式：账号登录、按用户隔离数据、服务端持有 API Key、SSE 代理。

## 快速开始（静态版）

需要 Node.js 22.12+ 和 pnpm。

```sh
pnpm install
pnpm dev
```

打开 http://localhost:8090。首次使用时，请在设置中填写 API Key。

构建静态站点：

```sh
pnpm build
```

产物位于 `dist/`，可部署到任意静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 服务器模式

服务器模式保留同样的聊天体验，但把账号、历史、附件和 API Key 移到服务器端。后端使用 Fastify，可通过 PM2 部署。

```text
浏览器
  ├─ /api/auth/*       登录与会话
  ├─ /api/sessions/*   会话
  ├─ /api/files/:id    附件原件
  ├─ /api/history/*    官方 ZIP 导入/导出
  └─ /api/ai/*         DeepSeek 聊天 / 文件 / ASR / TTS 代理
              │
        Fastify + SQLite（data/chat-demo.sqlite）
              │
        DEEPSEEK_API_KEY（仅服务端）
```

服务器模式需要 **Anthropic 兼容** 的 DeepSeek API。`DEEPSEEK_API_ORIGIN` 应填写服务根地址（例如 `https://api.deepseek.com`），不要以 `/v1` 结尾；服务端会自行拼接 `/anthropic/v1/messages` 和 `/v1/tools/*`。只提供 OpenAI 兼容接口的第三方网关不能直接使用。

### 部署

1. 安装依赖并创建环境变量文件：

   ```sh
   pnpm install
   cp .env.example .env
   ```

2. 至少填写 `DEEPSEEK_API_KEY`；本机用 HTTP 测试时设置 `COOKIE_SECURE=false`；通过 Nginx/Caddy 反向代理时设置 `TRUST_PROXY=true`。

3. 构建服务器版前端和后端：

   ```sh
   pnpm build:server
   pnpm server:build
   ```

4. 创建账号（默认关闭注册）：

   ```sh
   pnpm server:user add alice
   pnpm server:user passwd alice
   pnpm server:user list
   ```

5. 用 PM2 启动（也可以直接运行 `node server/dist/server/src/index.js`）：

   ```sh
   mkdir -p logs
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

6. 用 Nginx/Caddy 反向代理 8080 端口。[`deploy/nginx.conf.example`](deploy/nginx.conf.example) 已关闭 SSE 缓冲并放宽上传限制。生产环境请使用 HTTPS，登录 Cookie 才会带 `Secure`。

### 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | 服务端 DeepSeek API Key，不会下发浏览器。 |
| `DEEPSEEK_API_ORIGIN` | `https://api.deepseek.com` | API 服务根地址，必须提供 Anthropic 兼容接口。 |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Fastify 监听地址。 |
| `DATA_DIR` | `./data` | SQLite 与数据目录。 |
| `SESSION_TTL_DAYS` | `30` | 登录会话有效期。 |
| `COOKIE_SECURE` | 生产环境为 `true` | 本机 HTTP 测试时设为 `false`。 |
| `TRUST_PROXY` | `false` | 反向代理后运行时设为 `true`。 |
| `ALLOW_REGISTRATION` | `false` | 默认关闭注册。 |
| `REGISTRATION_CODE` | 空 | 开放注册时可选的邀请码。 |
| `MAX_SESSION_MB` | `32` | 单个会话 JSON 请求上限。 |
| `MAX_FILE_MB` | `64` | 单个附件大小上限。 |
| `MAX_IMPORT_MB` | `512` | 上传的历史 ZIP 大小上限。 |
| `MAX_IMPORT_UNCOMPRESSED_MB` | `2048` | 解压后的历史数据总量上限。 |
| `MAX_USER_STORAGE_MB` | `2048` | 每个账号的附件存储配额。 |
| `AI_REQUESTS_PER_MINUTE` | `30` | 每个账号每分钟 AI 代理请求上限。 |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MINUTES` | `10` / `10` | 登录尝试限流。 |

### 数据、导入与导出

- 会话、消息分支和附件原件保存在 SQLite（`data/chat-demo.sqlite`）。
- 前端保留按用户隔离的 IndexedDB 缓存，用于快速读取和弱网兜底；服务器是事实来源。
- 设置 → 数据管理 → 导入历史对话，可上传官方 `deepseek_data-*.zip` v3 归档。选择“覆盖”会删除服务器现有全部会话；选择“合并”会跳过同 ID 的会话。
- 设置 → 数据管理 → 导出所有历史对话，下载同样格式的 v3 ZIP，可再导入静态版或官方网页端。
- 设置 → 数据管理 → 上传本机历史到服务器，可把旧版本地缓存迁移到当前账号。
- 删除会话时会回收服务器上不再被其他会话引用的附件原件；已上传到 DeepSeek Files API 的文件不会删除。

建议定期备份数据库：

```sh
sqlite3 data/chat-demo.sqlite ".backup 'backup/chat-demo.sqlite'"
```

SQLite 是写入存储，后端请保持单实例运行。所有账号共用服务器上的 API Key，会共同消耗额度；默认关闭注册，并按用户限制 AI 请求频率。

## 数据存储

静态模式下，API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

服务器模式下，API Key 由服务端持有，账号与会话存入 SQLite，详见[服务器模式](#服务器模式)。

## 开发

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动静态版开发服务器 |
| `pnpm build` | 构建静态版到 `dist/` |
| `pnpm dev:server` | 启动后端（8080） |
| `pnpm dev:web` | 以服务器模式启动前端（8090） |
| `pnpm build:server` | 构建服务器版前端 |
| `pnpm server:build` | 编译后端到 `server/dist/` |
| `pnpm server:start` | 运行已编译的后端 |
| `pnpm server:user` | 管理账号 |
| `pnpm test:server` | 运行后端集成测试 |
| `pnpm type` | TypeScript 类型检查 |
| `pnpm lint` | oxlint 检查 |
| `pnpm format` | oxfmt 格式化 |

开发服务器：

```sh
corepack pnpm dev:server   # 后端，8080
corepack pnpm dev:web      # 服务器模式前端，8090，代理 /api
```

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, serverMode, devServer })` 支持自定义 API 地址、启用服务器模式和配置开发代理。

## 目录结构

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
server/
  src/                 Fastify 服务、SQLite 存储、认证、AI 代理与历史导入导出
  test/                后端集成测试
deploy/                反向代理示例
```

## 兼容性与限制

- 导入/导出只支持 `export_format_version: 3` 的归档；其他版本需要扩展 schema。
- 服务器模式需要 Anthropic 兼容的 Messages / Files API；只提供 OpenAI 兼容接口的网关不能直接用。
- 智能搜索和链接阅读是由所连接 API 服务执行的服务端工具，不是本地爬虫；是否可用取决于 API 提供方。
- 官方 API 下，模型调用中的服务端搜索/抓取工具不单独按次收费，但结果会进入上下文并按 token 计费，详见[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)。
- 服务器模式暂不包含消息全文搜索、分享链接、管理后台和多机水平扩展。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
