#!/usr/bin/env node
// Smoke test: token manager + auth middleware against a live server instance.
// Run with: node test/smoke.mjs
import { execFileSync, spawn } from "child_process";
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tokensFile = path.join(serverDir, "test", "tokens.smoke.json");
const PORT = process.env.SMOKE_PORT || "8977";
const BASE = `http://127.0.0.1:${PORT}`;
// No MCP_REQUIRE_AUTH: auth must switch on automatically once active tokens exist (fail-closed)
const env = { ...process.env, MCP_TOKENS_FILE: tokensFile, PORT };
delete env.MCP_REQUIRE_AUTH;

const tokenCli = (...args) =>
    execFileSync("node", [path.join(serverDir, "scripts", "token.js"), ...args], { env, encoding: "utf8" });

fs.rmSync(tokensFile, { force: true });

// --- token manager ---
const created = tokenCli("create", "--name", "smoke", "--ttl", "1h");
const goodToken = created.match(/smoke: ([0-9a-f]{64})/)[1];
tokenCli("create", "--name", "doomed");
tokenCli("revoke", "doomed");
const listed = tokenCli("list");
assert(listed.includes("active"), "expected an active token");
assert(listed.includes("revoked"), "expected a revoked token");
const revokedToken = JSON.parse(fs.readFileSync(tokensFile, "utf8")).find((t) => t.name === "doomed").token;
console.log("token manager: OK");

// --- live auth ---
const server = spawn("node", [path.join(serverDir, "index.js")], { env, stdio: "ignore" });

const status = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    res.body?.cancel();
    return res.status;
};

try {
    // wait for startup
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
        up = await status(`${BASE}/sse?token=startup-probe`).then(() => true).catch(() => false);
        if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert(up, "server did not start");

    assert.equal(await status(`${BASE}/sse`), 401, "request without token must be rejected");
    assert.equal(await status(`${BASE}/sse?token=wrong`), 401, "unknown token must be rejected");
    assert.equal(await status(`${BASE}/sse?token=${revokedToken}`), 401, "revoked token must be rejected");
    assert.equal(await status(`${BASE}/sse?token=${goodToken}`), 200, "valid token must be accepted");
    console.log("auth middleware: OK");
} finally {
    server.kill("SIGTERM");
    fs.rmSync(tokensFile, { force: true });
}
console.log("SMOKE OK");
