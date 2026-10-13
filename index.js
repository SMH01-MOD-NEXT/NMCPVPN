import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";
import fs from "fs/promises";
import { exec, execFile } from "child_process";
import { globby } from "globby";
import axios from "axios";
import TurndownService from "turndown";
import path from "path";
import { assertAllowed } from "./security.js";
import { authEnabled, createAuthMiddleware, TOKENS_FILE } from "./auth.js";
import { oauthEnabled, setupOAuth, OAUTH_PUBLIC_PATHS, OAUTH_FILE } from "./oauth.js";
import { registerExtraTools } from "./tools-extra.js";
import { registerImageTools } from "./tools-image.js";

// -----------------------------
// Logging helper
// -----------------------------
const log = (...args) => {
    console.error(`[${new Date().toISOString()}]`, ...args);
};

// -----------------------------
// Tool Definitions
// -----------------------------
// Мы сохраняем определения инструментов отдельно, чтобы создавать новые экземпляры сервера для каждого подключения
const registeredTools = [];

// MCP tool annotations. Clients (Notion, Claude, ChatGPT) use readOnlyHint to
// split tools into read / write and to decide which calls need approval.
// Tools missing here get no hints, which clients treat as "write".
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const TOOL_ANNOTATIONS = {
    // filesystem
    readFile: { ...READ, title: "Read file" },
    listDirectory: { ...READ, title: "List directory" },
    searchFiles: { ...READ, title: "Search files" },
    findFiles: { ...READ, title: "Find files" },
    writeFile: { ...DESTRUCTIVE, idempotentHint: true, title: "Write file" },
    editFile: { ...DESTRUCTIVE, title: "Edit file" },
    // shell & processes
    executeShell: { ...DESTRUCTIVE, openWorldHint: true, title: "Execute shell command" },
    startProcess: { ...DESTRUCTIVE, openWorldHint: true, title: "Start background process" },
    stopProcess: { ...DESTRUCTIVE, title: "Stop background process" },
    processStatus: { ...READ, idempotentHint: false, title: "Process status" },
    readProcessOutput: { ...READ, idempotentHint: false, title: "Read process output" },
    // git
    gitStatus: { ...READ, title: "Git status" },
    gitDiff: { ...READ, title: "Git diff" },
    gitLog: { ...READ, title: "Git log" },
    gitShow: { ...READ, title: "Git show" },
    gitCommit: { ...WRITE, title: "Git commit" },
    gitBranch: { ...WRITE, title: "Git branch (list / create / switch)" },
    // images (compareImages only writes when diffPath is given)
    readImage: { ...READ, title: "Read image" },
    compareImages: { ...READ, title: "Compare images" },
    // web & memory
    fetchUrl: { ...READ, idempotentHint: false, openWorldHint: true, title: "Fetch URL" },
    getValue: { ...READ, title: "Get stored value" },
    storeValue: { ...WRITE, idempotentHint: true, title: "Store value" },
};

const defineTool = (name, description, schema, handler) => {
    registeredTools.push({ name, description, schema, handler });
};

defineTool("readFile", "Read a file", {
    path: z.string().describe("Path to the file")
}, async ({ path }) => {
    log("Reading file:", path);
    try {
        const data = await fs.readFile(assertAllowed(path), "utf8");
        return { content: [{ type: "text", text: data }] };
    } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
    }
});

defineTool("writeFile", "Write a file", {
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write")
}, async ({ path: filePath, content }) => {
    log("Writing file:", filePath);
    try {
        const resolved = assertAllowed(filePath);
        // Create parent directories so nested paths do not fail with ENOENT
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        return { content: [{ type: "text", text: "File written successfully" }] };
    } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
    }
});

defineTool("listDirectory", "List directory contents", {
    path: z.string().describe("Path to the directory")
}, async ({ path }) => {
    log("Listing directory:", path);
    try {
        const items = await fs.readdir(assertAllowed(path));
        return { content: [{ type: "text", text: items.join("\n") }] };
    } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
    }
});

defineTool("executeShell", "Execute a shell command", {
    command: z.string().describe("Command to execute")
}, async ({ command }) => {
    log("Executing command:", command);
    return new Promise((resolve) => {
        // ВАЖНО: на NixOS нет /bin/bash, есть только /bin/sh.
        // Если очень нужен bash, используйте shell: "bash" (найдётся через PATH).
        exec(command, {
            shell: "/bin/sh",
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024
        }, (err, stdout, stderr) => {
            let output = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
            if (err) {
                // Не глотаем ошибку запуска: без этого невозможно диагностировать сбой
                output = `ERROR: ${err.message}\n${output}`;
                log("executeShell error:", err.message);
            }
            resolve({
                content: [{ type: "text", text: output }],
                isError: err !== null
            });
        });
    });
});

defineTool("searchFiles", "Search for a pattern in files (grep-like)", {
    pattern: z.string().describe("Regex or text pattern to search for"),
    path: z.string().optional().default(".").describe("Directory to search in"),
    include: z.string().optional().describe("Glob pattern for files to include")
}, async ({ pattern, path: searchPath, include }) => {
    log("Searching files for pattern:", pattern, "in", searchPath);
    try {
        searchPath = assertAllowed(searchPath);
    } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return new Promise((resolve) => {
        let command = `grep -rnE "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
        if (include) {
            command = `grep -rnE --include="${include}" "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
        }
        exec(command, { shell: "/bin/sh" }, (err, stdout, stderr) => {
            if (err && err.code !== 1) { // grep returns 1 if no matches found
                resolve({ content: [{ type: "text", text: `Error: ${err.message}\n${stderr}` }], isError: true });
            } else {
                const results = stdout || "No matches found.";
                resolve({ content: [{ type: "text", text: results }] });
            }
        });
    });
});

defineTool("findFiles", "Find files by glob pattern", {
    pattern: z.string().describe("Glob pattern (e.g. src/**/*.js)"),
    cwd: z.string().optional().default(".").describe("Working directory")
}, async ({ pattern, cwd }) => {
    log("Finding files with pattern:", pattern, "in", cwd);
    try {
        const files = await globby(pattern, { cwd: assertAllowed(cwd) });
        return { content: [{ type: "text", text: files.join("\n") || "No files found." }] };
    } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
    }
});

// -----------------------------
// Memory Persistence
// -----------------------------
const MEMORY_FILE = path.join(process.cwd(), "memory.json");

async function readMemory() {
    try {
        const data = await fs.readFile(MEMORY_FILE, "utf8");
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

async function writeMemory(memory) {
    await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
}

defineTool("storeValue", "Store a value in persistent memory", {
    key: z.string().describe("Key to store"),
    value: z.any().describe("Value to store")
}, async ({ key, value }) => {
    log("Storing memory:", key);
    const memory = await readMemory();
    memory[key] = value;
    await writeMemory(memory);
    return { content: [{ type: "text", text: `Value stored for key: ${key}` }] };
});

defineTool("getValue", "Retrieve a value from persistent memory", {
    key: z.string().describe("Key to retrieve")
}, async ({ key }) => {
    log("Retrieving memory:", key);
    const memory = await readMemory();
    const value = memory[key];
    if (value === undefined) {
        return { content: [{ type: "text", text: `No value found for key: ${key}` }], isError: true };
    }
    return { content: [{ type: "text", text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
});

// -----------------------------
// Web Tools
// -----------------------------
const turndownService = new TurndownService();

defineTool("fetchUrl", "Fetch content from a URL and convert to Markdown", {
    url: z.string().describe("URL to fetch")
}, async ({ url }) => {
    log("Fetching URL:", url);
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MCP-Server/1.0)' }
        });
        const html = response.data;
        // Basic check if it's HTML
        if (typeof html === 'string' && html.includes('<html')) {
            const markdown = turndownService.turndown(html);
            return { content: [{ type: "text", text: markdown }] };
        } else {
            return { content: [{ type: "text", text: typeof html === 'string' ? html : JSON.stringify(html, null, 2) }] };
        }
    } catch (error) {
        return { content: [{ type: "text", text: `Fetch error: ${error.message}` }], isError: true };
    }
});

// -----------------------------
// Git Integration
// -----------------------------
defineTool("gitStatus", "Get git status", {
    path: z.string().optional().describe("Repository directory (defaults to server cwd)")
}, async ({ path: repoPath }) => {
    log("Getting git status", repoPath || "");
    const repoCwd = assertAllowed(repoPath || process.cwd());
    return new Promise((resolve) => {
        exec("git status", { cwd: repoCwd }, (err, stdout, stderr) => {
            resolve({ content: [{ type: "text", text: stdout || stderr }], ...(err ? { isError: true } : {}) });
        });
    });
});

defineTool("gitDiff", "Get git diff", {
    path: z.string().optional().describe("Optional file path to get diff for"),
    cwd: z.string().optional().describe("Repository directory (defaults to server cwd)")
}, async ({ path: diffPath, cwd }) => {
    log("Getting git diff", diffPath || "");
    const repoCwd = assertAllowed(cwd || process.cwd());
    return new Promise((resolve) => {
        // execFile passes args directly (no shell), so paths cannot inject commands
        const args = diffPath ? ["diff", "--", diffPath] : ["diff"];
        execFile("git", args, { cwd: repoCwd }, (err, stdout, stderr) => {
            resolve({ content: [{ type: "text", text: stdout || stderr || "No changes." }], ...(err ? { isError: true } : {}) });
        });
    });
});

defineTool("gitCommit", "Commit changes", {
    message: z.string().describe("Commit message"),
    cwd: z.string().optional().describe("Repository directory (defaults to server cwd)")
}, async ({ message, cwd }) => {
    log("Committing changes:", message);
    const repoCwd = assertAllowed(cwd || process.cwd());
    // execFile passes the message as a plain argument (no shell), preventing command injection
    const git = (args) => new Promise((resolve, reject) => {
        execFile("git", args, { cwd: repoCwd }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\n${stderr}`));
            else resolve(stdout);
        });
    });
    try {
        await git(["add", "."]);
        const out = await git(["commit", "-m", message]);
        return { content: [{ type: "text", text: out }] };
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
});

// -----------------------------
// Extra tools (editFile, background processes, git extras)
// -----------------------------
registerExtraTools(defineTool, log);

// -----------------------------
// Image tools (readImage, compareImages)
// -----------------------------
registerImageTools(defineTool, log);

// Функция для создания и настройки нового экземпляра сервера
function createServerInstance() {
    const server = new McpServer({
        name: "combined-mcp-server",
        version: "1.0.0"
    });
    // Регистрируем все инструменты в новом экземпляре
    for (const t of registeredTools) {
        const annotations = TOOL_ANNOTATIONS[t.name];
        if (annotations) server.tool(t.name, t.description, t.schema, annotations, t.handler);
        else server.tool(t.name, t.description, t.schema, t.handler);
    }
    return server;
}

// -----------------------------
// Server Start Logic
// -----------------------------

// Transport selection: MCP_TRANSPORT=both (default) | http | sse | stdio,
// or `node index.js --transport http`. USE_STDIO=true still means stdio.
const transportArg = (() => {
    const i = process.argv.findIndex((a) => a === "--transport" || a.startsWith("--transport="));
    if (i < 0) return undefined;
    return process.argv[i].includes("=") ? process.argv[i].split("=")[1] : process.argv[i + 1];
})();
const TRANSPORT = String(transportArg || process.env.MCP_TRANSPORT || (process.env.USE_STDIO === "true" ? "stdio" : "both")).toLowerCase();
const TRANSPORT_ALIASES = { both: "both", all: "both", http: "http", streamable: "http", "streamable-http": "http", sse: "sse", stdio: "stdio" };
if (!TRANSPORT_ALIASES[TRANSPORT]) {
    console.error(`Unknown transport "${TRANSPORT}". Use one of: both, http, sse, stdio`);
    process.exit(1);
}
const MODE = TRANSPORT_ALIASES[TRANSPORT];
const SSE_ENABLED = MODE === "both" || MODE === "sse";
const HTTP_ENABLED = MODE === "both" || MODE === "http";

const app = express();
const transports = new Map();

// Behind cloudflared / nginx: trust X-Forwarded-* from the proxy (rate limiting, https detection)
const trustProxy = process.env.MCP_TRUST_PROXY ?? "loopback";
app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy)
    : trustProxy === "true" ? true : trustProxy === "false" ? false : trustProxy);

// OAuth 2.1 (DCR + Authorization Code/PKCE), enabled by MCP_PUBLIC_URL or MCP_OAUTH=1 (see oauth.js)
const oauth = oauthEnabled() ? setupOAuth(app, process.env.PORT || 8000) : null;

// Bearer auth: static tokens from tokens.json (scripts/token.js) and OAuth access tokens
app.use(createAuthMiddleware({ oauth, publicPaths: OAUTH_PUBLIC_PATHS }));

// -----------------------------
// Legacy SSE transport: GET /sse + POST /messages
// -----------------------------
if (SSE_ENABLED) {
    app.get("/sse", async (req, res) => {
        log("New SSE connection request");

        // 1. Настройки сокета
        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
        req.socket.setKeepAlive(true);

        // 2. Дополнительные заголовки (SDK сама добавит Content-Type и Cache-Control)
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Connection", "keep-alive");

        // 3. Перехватываем writeHead: даем SDK выставить 200 OK, и СРАЗУ плюем 4KB в сокет
        const originalWriteHead = res.writeHead.bind(res);
        let intervalId = null;

        res.writeHead = function (statusCode, headers) {
            // Вызываем оригинальный writeHead от Express/Node
            const result = originalWriteHead(statusCode, headers);

            // В тот же миг выплевываем 4KB пробелов/комментариев для Cloudflare
            res.write(`: ${' '.repeat(4096)}\n\n`);

            // Запускаем heartbeat каждые 15 сек против таймаутов CF (524 Error)
            intervalId = setInterval(() => {
                try {
                    res.write(": keepalive\n\n");
                } catch (e) {
                    clearInterval(intervalId);
                }
            }, 15000);

            return result;
        };

        // 4. Очистка при закрытии
        const cleanup = () => {
            if (intervalId) clearInterval(intervalId);
            if (transport) transports.delete(transport.sessionId);
        };

            req.on("close", cleanup);

            // 5. Инициализируем SDK
            const transport = new SSEServerTransport("/messages", res);
            const serverInstance = createServerInstance();

            transports.set(transport.sessionId, transport);

            transport.onclose = () => {
                log("SSE connection closed for session:", transport.sessionId);
                cleanup();
            };

            // В этот момент SDK вызовет res.writeHead(), наш патч сработает и пробьет CF
            await serverInstance.connect(transport);
            log("Server instance connected to SSE session:", transport.sessionId);
    });

    app.post("/messages", async (req, res) => {
        const sessionId = req.query.sessionId;
        const transport = transports.get(sessionId);
        if (transport) {
            await transport.handlePostMessage(req, res);
        } else {
            res.status(404).send("Session not found");
        }
    });
}

// -----------------------------
// Streamable HTTP transport (MCP spec 2025-03-26+): POST/GET/DELETE /mcp
// -----------------------------
if (HTTP_ENABLED) {
    const httpSessions = new Map(); // sessionId -> { transport, server, lastSeen }
    const SESSION_IDLE_MS = Number(process.env.MCP_HTTP_SESSION_IDLE_MS || 30 * 60 * 1000);
    const rpcError = (res, status, code, message) =>
        res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
    const isInit = (body) => (Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body));

    app.post("/mcp", express.json({ limit: "50mb" }), async (req, res) => {
        try {
            const sid = req.headers["mcp-session-id"];
            let entry = sid ? httpSessions.get(sid) : undefined;
            if (!entry) {
                // Unknown session -> 404 so the client re-initializes (per spec)
                if (sid) return rpcError(res, 404, -32001, "Session not found");
                if (!isInit(req.body)) return rpcError(res, 400, -32000, "Bad Request: send initialize first (no mcp-session-id)");

                const server = createServerInstance();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        httpSessions.set(id, entry);
                        log("Streamable HTTP session started:", id);
                    },
                });
                entry = { transport, server, lastSeen: Date.now() };
                transport.onclose = () => {
                    if (transport.sessionId && httpSessions.delete(transport.sessionId)) {
                        log("Streamable HTTP session closed:", transport.sessionId);
                    }
                };
                await server.connect(transport);
            }
            entry.lastSeen = Date.now();
            await entry.transport.handleRequest(req, res, req.body);
        } catch (e) {
            log("Streamable HTTP error:", e?.message || e);
            if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
        }
    });

    // GET opens the server->client SSE stream, DELETE ends the session
    const sessionRequest = async (req, res) => {
        const sid = req.headers["mcp-session-id"];
        const entry = sid && httpSessions.get(sid);
        if (!entry) return sid ? rpcError(res, 404, -32001, "Session not found") : rpcError(res, 400, -32000, "Missing mcp-session-id");
        entry.lastSeen = Date.now();
        if (req.method === "GET") {
            req.socket.setTimeout(0);
            req.socket.setKeepAlive(true);
            res.setHeader("X-Accel-Buffering", "no");
        }
        try {
            await entry.transport.handleRequest(req, res);
        } catch (e) {
            log("Streamable HTTP error:", e?.message || e);
            if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
        }
    };
    app.get("/mcp", sessionRequest);
    app.delete("/mcp", sessionRequest);

    // Drop sessions whose client vanished without DELETE
    setInterval(() => {
        const cutoff = Date.now() - SESSION_IDLE_MS;
        for (const [id, e] of httpSessions) {
            if (e.lastSeen < cutoff) {
                httpSessions.delete(id);
                e.transport.close().catch(() => {});
            }
        }
    }, 60_000).unref();
}

const PORT = process.env.PORT || 8000;

if (MODE === "stdio") {
    log("Starting MCP server in STDIO mode");
    const transport = new StdioServerTransport();
    const serverInstance = createServerInstance();
    await serverInstance.connect(transport);
} else {
    app.listen(PORT, () => {
        log(`MCP Server listening on port ${PORT} (transport: ${MODE})`);
        if (HTTP_ENABLED) log(`- Streamable HTTP endpoint: http://localhost:${PORT}/mcp`);
        if (SSE_ENABLED) log(`- SSE endpoint: http://localhost:${PORT}/sse`);
        log(`- OAuth: ${oauth ? `enabled, issuer ${oauth.baseUrl.href} (state: ${OAUTH_FILE})${process.env.MCP_OAUTH_PASSWORD ? "" : " - MCP_OAUTH_PASSWORD not set, consent needs a token from tokens.json"}` : "disabled (set MCP_PUBLIC_URL to enable)"}`);
        log(`- Auth: ${(oauth || authEnabled()) ? `enabled (tokens: ${TOKENS_FILE})` : "disabled (no active tokens; create one with scripts/token.js)"}`);
    });
}
