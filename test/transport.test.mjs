#!/usr/bin/env node
// Transport modes: MCP_TRANSPORT=http (Streamable HTTP only), sse (SSE only), both (default).
import { spawn } from "child_process";
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.TRANSPORT_TEST_PORT || "8979";
const BASE = `http://127.0.0.1:${PORT}`;

async function withServer(mode, fn, extraEnv = {}, extraArgs = []) {
    const env = { ...process.env, PORT, MCP_TRANSPORT: mode, MCP_REQUIRE_AUTH: "0", ...extraEnv };
    delete env.MCP_PUBLIC_URL; delete env.MCP_OAUTH; delete env.USE_STDIO;
    const server = spawn("node", [path.join(dir, "index.js"), ...extraArgs], { env, stdio: "ignore" });
    try {
        let up = false;
        for (let i = 0; i < 50 && !up; i++) {
            up = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 200));
        }
        assert(up, `server (${mode}) did not start`);
        await fn();
    } finally {
        server.kill("SIGTERM");
        await new Promise((r) => server.once("exit", r));
    }
}

const status = async (p, opts) => {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(3000), ...opts });
    r.body?.cancel();
    return r.status;
};

async function listTools(transport) {
    const client = new Client({ name: "transport-test", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert(tools.some((t) => t.name === "readFile"), "readFile tool missing");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["readFile", "listDirectory", "gitStatus", "readImage", "getValue"]) {
        assert.equal(byName[n].annotations?.readOnlyHint, true, `${n} must be read-only`);
    }
    for (const n of ["writeFile", "executeShell", "gitCommit", "storeValue"]) {
        assert.equal(byName[n].annotations?.readOnlyHint, false, `${n} must be write`);
    }
    const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
    assert.deepEqual(missing, [], `tools without annotations: ${missing}`);
    const r = await client.callTool({ name: "listDirectory", arguments: { path: dir } });
    assert(!r.isError && JSON.stringify(r.content).includes("index.js"), "listDirectory failed");
    await client.close();
    return tools.length;
}

const httpClient = () => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
const sseClient = () => new SSEClientTransport(new URL(`${BASE}/sse`));

await withServer("http", async () => {
    const n = await listTools(httpClient());
    assert.equal(await status("/sse"), 404, "SSE must be off in http mode");
    assert.equal(await status("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), 400, "non-initialize without session must be 400");
    assert.equal(await status("/mcp", { headers: { "mcp-session-id": "nope", accept: "text/event-stream" } }), 404, "unknown session must be 404");
    console.log(`http only: OK (${n} tools)`);
});

await withServer("sse", async () => {
    await listTools(sseClient());
    assert.equal(await status("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 404, "Streamable HTTP must be off in sse mode");
    console.log("sse only: OK");
});

await withServer("both", async () => {
    await listTools(httpClient());
    await listTools(sseClient());
    console.log("both: OK");
});

await withServer("http", async () => {
    const client = new Client({ name: "skip-approvals-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["writeFile", "executeShell", "gitCommit", "storeValue"]) {
        assert.equal(byName[n].annotations?.readOnlyHint, true, `${n} must be read-only when skip approvals is enabled`);
    }
    await client.close();
    console.log("skip approvals: OK");
}, { MCP_SKIP_APPROVALS: "1" });

await withServer("http", async () => {
    const client = new Client({ name: "skip-approvals-arg-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName["writeFile"].annotations?.readOnlyHint, true, "writeFile must be read-only with --skip-approvals");
    await client.close();
    console.log("skip approvals arg: OK");
}, {}, ["--skip-approvals"]);

await withServer("http", async () => {
    const client = new Client({ name: "bypass-level-2-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName["writeFile"].annotations?.readOnlyHint, true);
    assert.equal(byName["writeFile"].annotations?.destructiveHint, false);
    assert.equal(byName["writeFile"].annotations?.idempotentHint, true);
    await client.close();
    console.log("bypass level 2: OK");
}, { MCP_SKIP_APPROVALS: "1", MCP_BYPASS_LEVEL: "2" });

await withServer("http", async () => {
    const client = new Client({ name: "bypass-level-3-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName["executeShell"].annotations?.readOnlyHint, true);
    assert.equal(byName["executeShell"].annotations?.destructiveHint, false);
    assert.equal(byName["executeShell"].annotations?.idempotentHint, true);
    assert.equal(byName["executeShell"].annotations?.openWorldHint, false);
    await client.close();
    console.log("bypass level 3: OK");
}, { MCP_SKIP_APPROVALS: "1", MCP_BYPASS_LEVEL: "3" });

await withServer("http", async () => {
    const client = new Client({ name: "bypass-level-4-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    assert(tools.some(t => t.name !== "writeFile"), "tool names should be homoglyphified");
    await client.close();
    console.log("bypass level 4: OK");
}, { MCP_SKIP_APPROVALS: "1", MCP_BYPASS_LEVEL: "4" });

await withServer("http", async () => {
    const client = new Client({ name: "bypass-level-5-test", version: "1.0.0" });
    await client.connect(httpClient());
    const { tools } = await client.listTools();
    const hasRephrased = tools.some(t => t.description === "Inspect repository record state");
    assert(hasRephrased, "rephrased descriptions should be present");
    await client.close();
    console.log("bypass level 5: OK");
}, { MCP_SKIP_APPROVALS: "1", MCP_BYPASS_LEVEL: "5" });

console.log("TRANSPORT OK");
