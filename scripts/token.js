#!/usr/bin/env node
// Token manager for the MCP server.
//
// Usage:
//   node scripts/token.js create [--name NAME] [--ttl 30d|12h|45m|forever] [--count N]
//   node scripts/token.js list
//   node scripts/token.js revoke <token-or-name>
//
// Tokens are stored in tokens.json next to the server
// (override with MCP_TOKENS_FILE). Enforcement requires MCP_REQUIRE_AUTH=1.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKENS_FILE = process.env.MCP_TOKENS_FILE || path.join(serverDir, "tokens.json");

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function save(tokens) {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
    try {
        fs.chmodSync(TOKENS_FILE, 0o600); // keep it private even if the file already existed
    } catch {}
}

// "30d" | "12h" | "45m" | "forever" -> ISO date string or null
function parseTtl(ttl) {
    if (!ttl || ttl === "forever") return null;
    const m = /^(\d+)([mhd])$/.exec(ttl);
    if (!m) {
        console.error(`Invalid --ttl "${ttl}". Use forms like 30d, 12h, 45m or forever.`);
        process.exit(1);
    }
    const factor = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    return new Date(Date.now() + Number(m[1]) * factor).toISOString();
}

function getFlag(args, name, fallback) {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const value = args[i + 1];
    if (value === undefined) {
        console.error(`Missing value for ${name}`);
        process.exit(1);
    }
    return value;
}

function describe(t) {
    const now = Date.now();
    let status = "active";
    if (t.revokedAt) status = "revoked";
    else if (t.expiresAt && Date.parse(t.expiresAt) <= now) status = "expired";
    const masked = t.token.slice(0, 8) + "..." + t.token.slice(-4);
    return `${status.padEnd(8)} ${masked}  name=${t.name}  created=${t.createdAt}  expires=${t.expiresAt || "never"}`;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
    case "create": {
        const count = Number(getFlag(args, "--count", "1"));
        if (!Number.isInteger(count) || count < 1) {
            console.error("--count must be a positive integer");
            process.exit(1);
        }
        const name = getFlag(args, "--name", "default");
        const expiresAt = parseTtl(getFlag(args, "--ttl", "forever"));
        const tokens = load();
        const created = [];
        for (let i = 0; i < count; i++) {
            const record = {
                token: crypto.randomBytes(32).toString("hex"),
                name: count > 1 ? `${name}-${i + 1}` : name,
                createdAt: new Date().toISOString(),
                expiresAt,
                revokedAt: null,
            };
            tokens.push(record);
            created.push(record);
        }
        save(tokens);
        console.log(`Created ${created.length} token(s) in ${TOKENS_FILE}:`);
        for (const record of created) {
            console.log(`${record.name}: ${record.token}`);
        }
        break;
    }
    case "list": {
        const tokens = load();
        if (tokens.length === 0) {
            console.log(`No tokens in ${TOKENS_FILE}`);
            break;
        }
        for (const t of tokens) console.log(describe(t));
        break;
    }
    case "revoke": {
        const target = args[0];
        if (!target) {
            console.error("Usage: node scripts/token.js revoke <token-or-name>");
            process.exit(1);
        }
        const tokens = load();
        let revoked = 0;
        for (const t of tokens) {
            if (!t.revokedAt && (t.token === target || t.name === target)) {
                t.revokedAt = new Date().toISOString();
                revoked++;
            }
        }
        save(tokens);
        console.log(revoked > 0 ? `Revoked ${revoked} token(s).` : "Nothing matched: no active token with that value or name.");
        if (revoked === 0) process.exit(1);
        break;
    }
    default:
        console.log("Usage:\n  node scripts/token.js create [--name NAME] [--ttl 30d|12h|45m|forever] [--count N]\n  node scripts/token.js list\n  node scripts/token.js revoke <token-or-name>");
        process.exit(command ? 1 : 0);
}
