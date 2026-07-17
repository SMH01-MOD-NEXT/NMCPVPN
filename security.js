// Path allowlist for file-system tools.
// Configure with MCP_ALLOWED_DIRS: a colon-separated list of absolute paths,
// e.g. MCP_ALLOWED_DIRS="/home/user/projects:/tmp".
// When unset, access is unrestricted (backwards compatible) and a warning is
// logged once at first use.
//
// Known limitation: symlinks pointing outside the allowlist are not resolved.
import path from "path";

const raw = process.env.MCP_ALLOWED_DIRS || "";

export const allowedDirs = raw
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));

let warned = false;

// Returns the resolved absolute path or throws if it is outside the allowlist.
export function assertAllowed(target) {
    const resolved = path.resolve(String(target));
    if (allowedDirs.length === 0) {
        if (!warned) {
            warned = true;
            console.error("[security] MCP_ALLOWED_DIRS is not set: file tools may access the whole filesystem");
        }
        return resolved;
    }
    const ok = allowedDirs.some(
        (dir) => resolved === dir || resolved.startsWith(dir + path.sep)
    );
    if (!ok) {
        throw new Error(`Access denied: "${resolved}" is outside MCP_ALLOWED_DIRS`);
    }
    return resolved;
}
