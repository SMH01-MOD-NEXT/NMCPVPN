# Combined MCP Server

A self-hosted [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that gives AI agents controlled access to a machine: filesystem, shell, background processes, git, web fetching and persistent key-value memory. Works over SSE (HTTP) or stdio.

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

## Tests

```bash
node test/smoke.mjs   # token manager + live auth checks
```

CI runs syntax checks and the smoke test on every push/tag (`.woodpecker.yml`, Codeberg Woodpecker).

## NixOS

```bash
nix develop      # shell with nodejs + git
npm install
nix run .#server # or just: node index.js
```
