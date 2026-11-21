# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

The repository also includes an optional server mode for multi-user, server-side chat history. See [Server mode](#server-mode) below; the default build remains a static site.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Server mode

The optional server mode adds accounts, a server-side DeepSeek API key, and SQLite-backed conversations so the same history is available on every device. It is built with Fastify and can be deployed with PM2.

1. Install dependencies and create the environment file:

   ```sh
   pnpm install
   cp .env.example .env
   ```

2. Set at least `DEEPSEEK_API_KEY`, and set `COOKIE_SECURE=false` when testing over plain HTTP. `TRUST_PROXY=true` is required behind Nginx/Caddy.

3. Build the server-mode frontend and the backend:

   ```sh
   pnpm build:server
   pnpm server:build
   ```

4. Create accounts (registration is closed by default):

   ```sh
   pnpm server:user add alice
   pnpm server:user passwd alice
   pnpm server:user list
   ```

5. Start with PM2 (or run `node server/dist/server/src/index.js` directly):

   ```sh
   mkdir -p logs
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

6. Put Nginx/Caddy in front of port 8080. `deploy/nginx.conf.example` disables proxy buffering for the SSE chat stream and raises upload limits. Use HTTPS in production so the login cookie is sent with `Secure`.

What server mode provides:

- Username/password login, HttpOnly session cookies, per-user isolation.
- Conversations, message branches, and attachment originals stored in SQLite (`data/chat-demo.sqlite`).
- Import the official `deepseek_data-*.zip` export in Settings → Data, with Replace or Merge. The server validates the v3 archive atomically before touching existing data.
- Export the same v3 ZIP from the server, which can be imported back into the static app or the official web client.
- DeepSeek chat, Files API, ASR, and TTS requests proxied through the server; the API key never reaches the browser.
- Legacy browser history can be uploaded to the server from Settings → Data → Upload local history.

The frontend still keeps a per-user IndexedDB cache for fast reads and weak-network fallback; the server remains the source of truth. Back up `data/chat-demo.sqlite` (for example `sqlite3 data/chat-demo.sqlite ".backup 'backup.sqlite'"`). Single-instance deployment is required because SQLite is the write store.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

In static mode, your API key and settings are stored in the browser's localStorage; conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

In server mode, the API key is held by the server, accounts and conversations are stored in SQLite, and IndexedDB is only a per-user cache. See [Server mode](#server-mode).

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `pnpm dev`           | Start the static development server      |
| `pnpm build`         | Build the static site into `dist/`       |
| `pnpm dev:server`    | Start the backend on port 8080           |
| `pnpm dev:web`       | Start the frontend in server mode (8090) |
| `pnpm build:server`  | Build the server-mode frontend           |
| `pnpm server:build`  | Compile the backend into `server/dist/`  |
| `pnpm server:start`  | Run the compiled backend                 |
| `pnpm server:user`   | Manage accounts                          |
| `pnpm test:server`   | Run backend integration tests            |
| `pnpm type`          | Run TypeScript checks                    |
| `pnpm lint`          | Lint with oxlint                         |
| `pnpm format`        | Format with oxfmt                        |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, serverMode, devServer })` to customize the API origin, enable server mode, and configure the development proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
server/
  src/                 Fastify server, SQLite storage, auth, AI proxy, history import/export
  test/                Backend integration tests
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
