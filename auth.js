// Bearer-token authentication for the HTTP/SSE endpoints.
//
// - Tokens are stored in tokens.json next to the server
//   (override the location with MCP_TOKENS_FILE).
// - FAIL-CLOSED: auth is enforced automatically as soon as at least one
//   active token exists. MCP_REQUIRE_AUTH=1 forces auth on even with no
//   tokens (rejects everything); MCP_REQUIRE_AUTH=0 disables auth explicitly.
// - Manage tokens with `node scripts/token.js` (create/list/revoke).
// - The token file is re-read on every request, so newly created or revoked
//   tokens take effect immediately, without a server restart.
import fs from "fs";
import path from "path";

export const TOKENS_FILE =
    process.env.MCP_TOKENS_FILE || path.join(process.cwd(), "tokens.json");

const flag = String(process.env.MCP_REQUIRE_AUTH || "").toLowerCase();
const forcedOn = ["1", "true", "yes"].includes(flag);
const forcedOff = ["0", "false", "no"].includes(flag);

export function loadTokens() {
    try {
        const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function isActive(t, now) {
    return !t.revokedAt && (t.expiresAt == null || Date.parse(t.expiresAt) > now);
}

export function hasActiveTokens() {
    const now = Date.now();
    return loadTokens().some((t) => isActive(t, now));
}

// Evaluated per request so that creating the first token (or revoking the
// last one) changes enforcement without a restart.
export function authEnabled() {
    if (forcedOff) return false;
    if (forcedOn) return true;
    return hasActiveTokens();
}

export function isValidToken(token) {
    if (!token || typeof token !== "string") return false;
    const now = Date.now();
    return loadTokens().some((t) => t.token === token && isActive(t, now));
}

// Express middleware. Accepts the token from "Authorization: Bearer <token>"
// or from the "token" query parameter (SSE clients often cannot set headers).
export function requireAuth(req, res, next) {
    if (!authEnabled()) return next();
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer || req.query.token;
    if (isValidToken(token)) return next();
    res.status(401).json({ error: "Unauthorized: valid token required" });
}
