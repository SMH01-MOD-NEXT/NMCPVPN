# Combined MCP Server

A self-hosted [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that gives AI agents controlled access to a machine: filesystem, shell, background processes, git, web fetching and persistent key-value memory. Works over Streamable HTTP, SSE or stdio.

## Tools

### Filesystem
| Tool | Description |
|---|---|
| `readFile` | Read a file |
| `writeFile` | Write a file (parent directories are created automatically) |
| `editFile` | Replace an exact string in a file; preserves file permissions, fails if the match is ambiguous |
| `listDirectory` | List directory contents |
| `searchFiles` | Grep-like regex search (`pattern`, `path`, optional `include` glob) |
| `findFiles` | Find files by glob pattern (`src/**/*.js`) |

### Shell & processes
| Tool | Description |
|---|---|
| `executeShell` | Run a command via `/bin/sh` (60 s timeout, 10 MB output cap) |
| `startProcess` | Start a long-running background process (dev server, build) |
| `processStatus` | List background processes or inspect one |
| `readProcessOutput` | Read captured stdout+stderr (ring buffer, 200 KB per process) |
| `stopProcess` | Send a signal to a background process (default `SIGTERM`) |

### Git
All git tools accept a repository directory (`path`/`cwd`) and default to the server working directory. Arguments are passed to git without a shell, so commit messages and paths cannot inject commands.
| Tool | Description |
|---|---|
| `gitStatus` | `git status` |
| `gitDiff` | `git diff`, optionally for one file |
| `gitCommit` | `git add . && git commit -m <message>` |
| `gitLog` | Recent commits, optionally for one path |
| `gitBranch` | List, create or switch branches |
| `gitShow` | Show a commit (message + diff, or `--stat` summary) |

### Images
Pixel work is done with Pillow through `python3` (override the interpreter with `MCP_PYTHON`). Both tools return MCP `image` content, so a model can actually look at the result, plus a JSON line with the measurements.
| Tool | Description |
|---|---|
| `readImage` | View an image file: optional `crop` (`x`,`y`,`w`,`h`), `maxWidth`/`maxHeight` downscaling, `grid` overlay every N px, `format` (`png`/`jpeg`), `frame` for animations. Transparency is composited onto a checkerboard unless `flattenAlpha=false`. Oversized images are re-encoded and shrunk to fit `maxBytes` (1.2 MB default) |
| `compareImages` | Compare two images: mean (`mae`) and RMS difference, `changedPercent` above `threshold`, an N x N `regions` map, `changedBoundingBox`, and an amplified diff image returned inline and optionally written to `diffPath`. `b` is resized to `a` unless `resize=false` |

### Web & memory
| Tool | Description |
|---|---|
| `fetchUrl` | Fetch a URL and convert HTML to Markdown |
| `storeValue` / `getValue` | Persistent key-value memory (`memory.json`) |

## Quick start

```bash
npm install
node index.js            # SSE on http://localhost:8000/sse
PORT=9000 node index.js  # custom port
USE_STDIO=true node index.js  # stdio transport instead of HTTP
```

## Transports

| Mode | Endpoints | Start |
|---|---|---|
| `both` (default) | `/mcp` + `/sse` | `node index.js` |
| `http` | Streamable HTTP only: `POST/GET/DELETE /mcp` | `npm run start:http` or `MCP_TRANSPORT=http node index.js` |
| `sse` | Legacy SSE only: `GET /sse` + `POST /messages` | `npm run start:sse` or `MCP_TRANSPORT=sse node index.js` |
| `stdio` | stdin/stdout | `npm run start:stdio` (`USE_STDIO=true` still works) |

`--transport <mode>` on the command line overrides `MCP_TRANSPORT`. Streamable HTTP is stateful
(`mcp-session-id` header); sessions idle for 30 min are dropped (`MCP_HTTP_SESSION_IDLE_MS`).
Auth (static tokens and OAuth) applies to both HTTP transports; in clients use `https://<host>/mcp` for
Streamable HTTP and `https://<host>/sse` for SSE.

## Security

### Authentication (fail-closed)

Token auth for the HTTP endpoints turns on **automatically as soon as at least one active token exists** in `tokens.json`. `MCP_REQUIRE_AUTH=1` forces auth on even with no tokens (rejects everything); `MCP_REQUIRE_AUTH=0` disables auth explicitly:

```bash
# create tokens (any number, with TTL or forever)
node scripts/token.js create --name laptop --ttl 30d
node scripts/token.js create --name ci --count 5 --ttl 12h
node scripts/token.js create --name main            # never expires

node scripts/token.js list
node scripts/token.js revoke laptop                 # by name or by token value

node index.js   # auth is now enforced because active tokens exist
```

Clients pass the token as `Authorization: Bearer <token>` or `?token=<token>` in the SSE URL (many SSE clients cannot set headers). Tokens live in `tokens.json` (chmod 600; override with `MCP_TOKENS_FILE`). The file is re-read on every request, so revocation takes effect immediately without a restart.

### OAuth 2.1 (Dynamic Client Registration + Authorization Code with PKCE)

For clients that connect via OAuth (Notion custom MCP connections, Claude, ChatGPT, MCP Inspector) the server
is also a full OAuth 2.1 authorization server. Enable it by setting the public URL of the server:

```bash
MCP_PUBLIC_URL=https://mcp.example.com MCP_OAUTH_PASSWORD='long-random-secret' node index.js
```

Then add `https://mcp.example.com/sse` in the client and choose either option:

- **OAuth 2.0 (Dynamic Client Registration)**: nothing else to fill in, the client registers itself at `/register`.
- **OAuth 2.0 (Authorization Code + PKCE)**: register a client once and paste its `client_id` into the client
  (`curl -X POST https://mcp.example.com/register -H 'content-type: application/json' -d '{"client_name":"Notion","redirect_uris":["<redirect URI shown by the client>"],"token_endpoint_auth_method":"none"}'`).
  Authorization URL: `/authorize`, token URL: `/token`, scope: `mcp`.

When the client opens `/authorize`, a consent page asks for the owner secret: `MCP_OAUTH_PASSWORD`
or any active token from `tokens.json`. Approving issues an access token (1 h) and a refresh token (30 d, rotated on
every use).

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | Protected Resource Metadata (RFC 9728), advertised in `WWW-Authenticate` on 401 |
| `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization Code + PKCE (S256 only), consent page |
| `/token` | `authorization_code` and `refresh_token` grants |
| `/revoke` | Token revocation (RFC 7009) |

With OAuth enabled, auth is always enforced. Static tokens keep working alongside OAuth tokens.

| Variable | Default | |
|---|---|---|
| `MCP_PUBLIC_URL` | unset | Public https URL; enables OAuth (http is allowed only for localhost) |
| `MCP_OAUTH` | unset | `1` enables OAuth on `http://localhost:PORT`, `0` disables it |
| `MCP_OAUTH_PASSWORD` | unset | Owner secret for the consent page |
| `MCP_OAUTH_FILE` | `./oauth.json` | Clients and hashed tokens (chmod 600) |
| `MCP_OAUTH_ACCESS_TTL` / `MCP_OAUTH_REFRESH_TTL` | `3600` / `2592000` | Token lifetimes, seconds |
| `MCP_TRUST_PROXY` | `loopback` | Express `trust proxy` (for cloudflared / nginx in front) |

```bash
node scripts/oauth.js list              # registered clients and live tokens
node scripts/oauth.js revoke <client>   # drop a client and all its tokens
node scripts/oauth.js revoke-all
```

### Path allowlist (opt-in)

Restrict filesystem and git tools to specific directories:

```bash
MCP_ALLOWED_DIRS="/home/user/projects:/tmp" node index.js
```

When unset, file tools can access everything the server user can (a warning is logged).

### Known limitations

- `executeShell` and `startProcess` are **not** sandboxed: a shell command can touch anything the server user can, regardless of `MCP_ALLOWED_DIRS`. Disable or firewall them if you expose the server beyond localhost.
- The allowlist does not resolve symlinks pointing outside allowed directories.
- Prefer binding behind a reverse proxy with TLS when exposing the server to a network.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | HTTP port for SSE mode |
| `USE_STDIO` | unset | `true` = stdio transport instead of HTTP |
| `MCP_REQUIRE_AUTH` | auto | `1` = force auth on, `0` = force off; unset = on when active tokens exist |
| `MCP_TOKENS_FILE` | `./tokens.json` | Token storage location |
| `MCP_ALLOWED_DIRS` | unset | Colon-separated allowlist for file/git tools |
| `MCP_SKIP_APPROVALS` | unset | `1` / `true` / `yes` (or `--skip-approvals` flag) sets `readOnlyHint: true` for all tools, making clients treat write/destructive tools as read-only and skip approval prompts |

## Tests

```bash
node test/smoke.mjs              # token manager + live auth checks
node test/image-tools.test.mjs   # readImage + compareImages (needs Pillow)
```

CI runs syntax checks and the smoke test on every push/tag (`.woodpecker.yml`, Codeberg Woodpecker).

## NixOS

```bash
nix develop      # shell with nodejs + git
npm install
nix run .#server # or just: node index.js
```
