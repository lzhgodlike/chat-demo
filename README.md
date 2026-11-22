# chat-demo

English | [简体中文](README.zh-CN.md)

**A DeepSeek API chat application example: run it as a plain static site, or switch to a multi-user server mode with account login and server-side conversation storage.**

chat-demo demonstrates DeepSeek's Anthropic-compatible Messages / Files APIs: streaming replies, deep thinking, smart search, source citations, attachments, voice input/read-aloud, and message branches. The default build is a static site. The optional server mode uses Fastify + SQLite to keep conversations, attachment originals, and the DeepSeek API key on the server, and can import/export official DeepSeek data archives.

## Highlights

- Multiple conversations with automatic titles, rename/delete, prompt editing, regeneration, continuation, and message branch switching.
- Streaming responses with deep thinking, smart search, link reading, and citations.
- Upload, paste, and drag-and-drop attachments; voice input and read-aloud.
- Markdown, syntax highlighting, KaTeX, and Mermaid; Simplified Chinese/English; light/dark themes; mobile layout.
- Official `deepseek_data-YYYY-MM-DD.zip` (v3) import/export; server mode supports Replace or Merge.
- Optional server mode: accounts, per-user data isolation, server-held API key, and an SSE proxy.

## Quick start (static site)

Requirements: Node.js 22.12+ and pnpm.

```sh
pnpm install
pnpm dev
```

Open http://localhost:8090. Enter your API key in Settings before your first chat.

Build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to any static host or open `dist/index.html` directly. Opening the file directly requires browser storage support for `file://` pages and an API service that permits their cross-origin requests.

## Server mode

Server mode keeps the same chat experience while moving accounts, history, attachments, and the API key to the server. It is built with Fastify and can be deployed with PM2.

```text
Browser
  ├─ /api/auth/*       login and sessions
  ├─ /api/sessions/*   conversations
  ├─ /api/files/:id    attachment originals
  ├─ /api/history/*    official ZIP import/export
  └─ /api/ai/*         DeepSeek chat / files / ASR / TTS proxy
              │
        Fastify + SQLite (data/chat-demo.sqlite)
              │
        DEEPSEEK_API_KEY (server only)
```

Server mode expects an **Anthropic-compatible** DeepSeek API. `DEEPSEEK_API_ORIGIN` must be the service root (for example `https://api.deepseek.com`), not a URL ending in `/v1`; the server appends `/anthropic/v1/messages` and `/v1/tools/*` itself. A gateway that only exposes OpenAI-compatible endpoints is not supported out of the box.

### Deploy

1. Install dependencies and create the environment file:

   ```sh
   pnpm install
   cp .env.example .env
   ```

2. Set at least `DEEPSEEK_API_KEY`. Set `COOKIE_SECURE=false` when testing over plain HTTP; set `TRUST_PROXY=true` behind Nginx/Caddy.

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

6. Put Nginx/Caddy in front of port 8080. [`deploy/nginx.conf.example`](deploy/nginx.conf.example) disables proxy buffering for the SSE chat stream and raises upload limits. Use HTTPS in production so the login cookie is sent with `Secure`.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Server-side DeepSeek API key; never sent to the browser. |
| `DEEPSEEK_API_ORIGIN` | `https://api.deepseek.com` | API service root; must expose the Anthropic-compatible endpoints. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Fastify listen address. |
| `DATA_DIR` | `./data` | SQLite and data directory. |
| `SESSION_TTL_DAYS` | `30` | Login cookie/session lifetime. |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-HTTP local testing. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy. |
| `ALLOW_REGISTRATION` | `false` | Registration is disabled by default. |
| `REGISTRATION_CODE` | empty | Optional invite code when registration is enabled. |
| `MAX_SESSION_MB` | `32` | Maximum session JSON request size. |
| `MAX_FILE_MB` | `64` | Maximum single attachment size. |
| `MAX_IMPORT_MB` | `512` | Maximum uploaded history ZIP size. |
| `MAX_IMPORT_UNCOMPRESSED_MB` | `2048` | Maximum uncompressed history archive size. |
| `MAX_USER_STORAGE_MB` | `2048` | Per-user attachment storage quota. |
| `AI_REQUESTS_PER_MINUTE` | `30` | Per-user AI proxy request limit. |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MINUTES` | `10` / `10` | Login attempt rate limit. |

### Data, import, and export

- Conversations, message branches, and attachment originals are stored in SQLite (`data/chat-demo.sqlite`).
- The frontend keeps a per-user IndexedDB cache for fast reads and weak-network fallback; the server remains the source of truth.
- Settings → Data → Import chat history uploads an official `deepseek_data-*.zip` v3 archive. Choose **Replace** to delete existing server conversations or **Merge** to skip conversations with the same ID.
- Settings → Data → Export downloads the same v3 format and can be imported back into the static app or the official web client.
- Settings → Data → Upload local history migrates conversations cached by an older static version into the current account.
- Deleting chats removes server-side attachment originals when no other conversation references them. Files already uploaded to the DeepSeek Files API are not deleted.

Back up the database regularly:

```sh
sqlite3 data/chat-demo.sqlite ".backup 'backup/chat-demo.sqlite'"
```

SQLite is the write store, so run a single backend instance. A shared server API key means all accounts consume the same quota; registration is closed by default and AI requests are rate-limited per user.

## Data and storage

In static mode, the API key and settings live in the browser's localStorage, while conversations and attachment originals live in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

In server mode, the API key is held by the server and conversations are stored in SQLite. See [Server mode](#server-mode).

## Development

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the static development server |
| `pnpm build` | Build the static site into `dist/` |
| `pnpm dev:server` | Start the backend on port 8080 |
| `pnpm dev:web` | Start the frontend in server mode (port 8090) |
| `pnpm build:server` | Build the server-mode frontend |
| `pnpm server:build` | Compile the backend into `server/dist/` |
| `pnpm server:start` | Run the compiled backend |
| `pnpm server:user` | Manage accounts |
| `pnpm test:server` | Run backend integration tests |
| `pnpm type` | Run TypeScript checks |
| `pnpm lint` | Lint with oxlint |
| `pnpm format` | Format with oxfmt |

Development servers:

```sh
corepack pnpm dev:server   # backend, 8080
corepack pnpm dev:web      # frontend in server mode, 8090, proxies /api
```

`rspack.config.ts` uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, serverMode, devServer })` to customize the API origin, enable server mode, and configure the development proxy.

## Project layout

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
server/
  src/                 Fastify server, SQLite storage, auth, AI proxy, history import/export
  test/                Backend integration tests
deploy/                Reverse proxy example
```

## Compatibility and limits

- Import/export supports `export_format_version: 3` archives. Other versions need a schema extension.
- Server mode requires an Anthropic-compatible Messages / Files API; OpenAI-only gateways are not supported without an adapter.
- Smart search and link reading are server-side tools executed by the configured API service. They are not a local crawler; availability depends on the API provider.
- Server-side search/fetch tool calls are not billed per search by the official API, but their results enter the model context and are billed as tokens. See the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing).
- Server mode does not include full-text search, sharing links, an admin UI, or multi-instance horizontal scaling.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
