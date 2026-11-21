# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

仓库还包含可选的服务器模式，支持多账号和服务器端会话存储，见下文[服务器模式](#服务器模式)。默认构建仍是纯静态站点。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 服务器模式

服务器模式提供账号登录、服务端 DeepSeek API Key 和 SQLite 会话存储，换设备登录后可以看到同一份历史。后端使用 Fastify，可直接用 PM2 部署。

1. 安装依赖并创建环境变量文件：

   ```sh
   pnpm install
   cp .env.example .env
   ```

2. 至少填写 `DEEPSEEK_API_KEY`；在本机用 HTTP 测试时设置 `COOKIE_SECURE=false`；通过 Nginx/Caddy 反向代理时设置 `TRUST_PROXY=true`。

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

6. 用 Nginx/Caddy 反向代理 8080 端口。`deploy/nginx.conf.example` 已关闭 SSE 缓冲并放宽上传限制。生产环境请使用 HTTPS，登录 Cookie 才会带 `Secure`。

服务器模式提供：

- 用户名/密码登录、HttpOnly Cookie 会话、按用户隔离数据。
- 会话、消息分支和附件原件存入 SQLite（`data/chat-demo.sqlite`）。
- 设置 → 数据管理 → 导入历史对话，支持选择覆盖或合并，导入服务端会先完整校验官方 v3 归档，再在一个事务中写入。
- 从服务器导出同样格式的 v3 ZIP，可以再导入静态版或官方网页端。
- 聊天、Files API、ASR、TTS 全部由服务端代理，浏览器不再接触 API Key。
- 设置 → 数据管理 → 上传本机历史到服务器，可把旧版本机缓存迁移到当前账号。

前端仍保留按用户隔离的 IndexedDB 缓存，用于快速读取和弱网兜底；服务器是事实来源。请定期备份 `data/chat-demo.sqlite`（例如 `sqlite3 data/chat-demo.sqlite ".backup 'backup.sqlite'"`）。SQLite 单写，后端请保持单实例运行。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

静态模式下，API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

服务器模式下，API Key 由服务端持有，账号与会话存入 SQLite，IndexedDB 仅作为按用户隔离的缓存，详见[服务器模式](#服务器模式)。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令                | 用途                         |
| ------------------- | ---------------------------- |
| `pnpm dev`          | 启动静态版开发服务器         |
| `pnpm build`        | 构建静态版到 `dist/`         |
| `pnpm dev:server`   | 启动后端（8080）             |
| `pnpm dev:web`      | 以服务器模式启动前端（8090） |
| `pnpm build:server` | 构建服务器版前端             |
| `pnpm server:build` | 编译后端到 `server/dist/`    |
| `pnpm server:start` | 运行已编译的后端             |
| `pnpm server:user`  | 管理账号                     |
| `pnpm test:server`  | 运行后端集成测试             |
| `pnpm type`         | TypeScript 类型检查          |
| `pnpm lint`         | oxlint 检查                  |
| `pnpm format`       | oxfmt 格式化                 |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, serverMode, devServer })` 支持自定义 API 地址、启用服务器模式和配置开发代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
server/
  src/                 Fastify 服务、SQLite 存储、认证、AI 代理与历史导入导出
  test/                后端集成测试
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
