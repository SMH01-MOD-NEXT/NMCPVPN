import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
import { authEnabled, requireAuth, TOKENS_FILE } from "./auth.js";
import { registerExtraTools } from "./tools-extra.js";

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

// Функция для создания и настройки нового экземпляра сервера
function createServerInstance() {
    const server = new McpServer({
        name: "combined-mcp-server",
        version: "1.0.0"
    });
    // Регистрируем все инструменты в новом экземпляре
    for (const t of registeredTools) {
        server.tool(t.name, t.description, t.schema, t.handler);
    }
    return server;
}

// -----------------------------
// Server Start Logic
// -----------------------------

const app = express();
const transports = new Map();

// Bearer-token auth (opt-in): set MCP_REQUIRE_AUTH=1 and create tokens with scripts/token.js
app.use(requireAuth);

app.get("/sse", async (req, res) => {
    log("New SSE connection request");

    // 1. Настройка сокета против таймаутов
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    // 2. Устанавливаем заголовки (SDK сама вызовет res.writeHead(200), используя эти заголовки)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // 3. Перехватываем первый res.write от SDK, чтобы пробить буфер Cloudflare
    const originalWrite = res.write.bind(res);
    let isFirstChunk = true;
    let intervalId = null;

    res.write = function (chunk, encoding, callback) {
        if (isFirstChunk) {
            isFirstChunk = false;
            // Добавляем 4KB комментариев ПЕРЕД первым вызовом (event: endpoint)
            const padding = `: ${' '.repeat(4096)}\n\n`;

            if (typeof chunk === "string") {
                chunk = padding + chunk;
            } else if (Buffer.isBuffer(chunk)) {
                chunk = Buffer.concat([Buffer.from(padding), chunk]);
            }

            // Запускаем периодический keepalive каждые 15 сек, чтобы cloudflared не закрывал стрим
            intervalId = setInterval(() => {
                try {
                    originalWrite(": keepalive\n\n");
                } catch (e) {
                    clearInterval(intervalId);
                }
            }, 15000);
        }

        return originalWrite(chunk, encoding, callback);
    };

    // 4. Инициализация MCP
    const transport = new SSEServerTransport("/messages", res);
    const serverInstance = createServerInstance();

    transports.set(transport.sessionId, transport);

    const cleanup = () => {
        if (intervalId) clearInterval(intervalId);
        transports.delete(transport.sessionId);
    };

    transport.onclose = () => {
        log("SSE connection closed for session:", transport.sessionId);
        cleanup();
    };

    req.on("close", cleanup);

    // 5. Запуск (SDK сам отправит 200 OK и сработает перехваченный res.write)
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

const PORT = process.env.PORT || 8000;

if (process.env.USE_STDIO === "true") {
    log("Starting MCP server in STDIO mode");
    const transport = new StdioServerTransport();
    const serverInstance = createServerInstance();
    await serverInstance.connect(transport);
} else {
    app.listen(PORT, () => {
        log(`MCP Server listening for SSE on port ${PORT}`);
        log(`- SSE endpoint: http://localhost:${PORT}/sse`);
        log(`- Auth: ${authEnabled() ? `enabled (tokens: ${TOKENS_FILE})` : "disabled (no active tokens; create one with scripts/token.js)"}`);
    });
}
