// Extra tools for the MCP server: targeted file edits, background process
// management, and additional git commands.
import { execFile, spawn } from "child_process";
import fs from "fs/promises";
import { z } from "zod";
import { assertAllowed } from "./security.js";

const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

// execFile passes arguments directly (no shell), preventing command injection
const runGit = (args, cwd) =>
    new Promise((resolve) => {
        execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) resolve(err(`Error: ${error.message}\n${stderr}`));
            else resolve(ok(stdout || stderr || "OK"));
        });
    });

export function registerExtraTools(defineTool, log) {
    // -----------------------------
    // editFile
    // -----------------------------
    defineTool("editFile", "Edit a file by replacing an exact string. Preserves file permissions (unlike a full rewrite).", {
        path: z.string().describe("Path to the file"),
        oldStr: z.string().describe("Exact text to replace"),
        newStr: z.string().describe("Replacement text"),
        replaceAll: z.boolean().optional().default(false).describe("Replace every occurrence; by default oldStr must match exactly once")
    }, async ({ path: filePath, oldStr, newStr, replaceAll }) => {
        log("Editing file:", filePath);
        try {
            const resolved = assertAllowed(filePath);
            const data = await fs.readFile(resolved, "utf8");
            const count = data.split(oldStr).length - 1;
            if (count === 0) return err(`oldStr not found in ${filePath}`);
            if (count > 1 && !replaceAll) return err(`oldStr matches ${count} times; make it unique or pass replaceAll=true`);
            const updated = replaceAll ? data.split(oldStr).join(newStr) : data.replace(oldStr, newStr);
            await fs.writeFile(resolved, updated, "utf8");
            return ok(`Replaced ${replaceAll ? count : 1} occurrence(s) in ${filePath}`);
        } catch (error) {
            return err(error.message);
        }
    });

    // -----------------------------
    // Background processes
    // -----------------------------
    const processes = new Map();
    let nextProcessId = 1;
    const MAX_OUTPUT_CHARS = 200_000; // ring buffer per process

    const getProcess = (id) => processes.get(String(id));

    defineTool("startProcess", "Start a long-running background process (dev server, build, etc.)", {
        command: z.string().describe("Shell command to run"),
        cwd: z.string().optional().describe("Working directory (defaults to server cwd)"),
        name: z.string().optional().describe("Human-readable name")
    }, async ({ command, cwd, name }) => {
        const dir = assertAllowed(cwd || process.cwd());
        log("Starting process:", command, "in", dir);
        const child = spawn(command, { shell: "/bin/sh", cwd: dir });
        const id = String(nextProcessId++);
        const proc = {
            child,
            name: name || command.slice(0, 40),
            command,
            cwd: dir,
            startedAt: new Date().toISOString(),
            status: "running",
            exitCode: null,
            output: ""
        };
        const append = (chunk) => {
            proc.output += chunk.toString();
            if (proc.output.length > MAX_OUTPUT_CHARS) {
                proc.output = proc.output.slice(-MAX_OUTPUT_CHARS);
            }
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", (error) => {
            proc.status = "failed";
            proc.output += `\n[spawn error] ${error.message}`;
        });
        child.on("exit", (code, signal) => {
            proc.status = signal ? `killed (${signal})` : "exited";
            proc.exitCode = code;
        });
        processes.set(id, proc);
        return ok(`Started process ${id} (pid ${child.pid}): ${proc.name}`);
    });

    defineTool("processStatus", "Status of background processes started with startProcess", {
        id: z.string().optional().describe("Process id; omit to list all")
    }, async ({ id }) => {
        const describe = (pid, p) =>
            `${pid}: [${p.status}${p.exitCode !== null ? ` code=${p.exitCode}` : ""}] pid=${p.child.pid} started=${p.startedAt} cwd=${p.cwd} :: ${p.command}`;
        if (id) {
            const p = getProcess(id);
            if (!p) return err(`No process with id ${id}`);
            return ok(describe(id, p));
        }
        if (processes.size === 0) return ok("No background processes.");
        return ok([...processes.entries()].map(([pid, p]) => describe(pid, p)).join("\n"));
    });

    defineTool("readProcessOutput", "Read captured stdout+stderr of a background process", {
        id: z.string().describe("Process id"),
        tailChars: z.number().optional().default(20000).describe("Return only the last N characters")
    }, async ({ id, tailChars }) => {
        const p = getProcess(id);
        if (!p) return err(`No process with id ${id}`);
        const text = p.output.slice(-Math.max(0, tailChars)) || "(no output yet)";
        return ok(`[${p.status}${p.exitCode !== null ? ` code=${p.exitCode}` : ""}]\n${text}`);
    });

    defineTool("stopProcess", "Stop a background process", {
        id: z.string().describe("Process id"),
        signal: z.string().optional().default("SIGTERM").describe("Signal to send (e.g. SIGTERM, SIGKILL)")
    }, async ({ id, signal }) => {
        const p = getProcess(id);
        if (!p) return err(`No process with id ${id}`);
        if (p.status !== "running") return ok(`Process ${id} is already ${p.status}.`);
        try {
            p.child.kill(signal);
            return ok(`Sent ${signal} to process ${id} (pid ${p.child.pid}).`);
        } catch (error) {
            return err(error.message);
        }
    });

    // -----------------------------
    // Extra git commands
    // -----------------------------
    defineTool("gitLog", "Show recent commits", {
        cwd: z.string().optional().describe("Repository directory (defaults to server cwd)"),
        limit: z.number().optional().default(10).describe("Number of commits"),
        path: z.string().optional().describe("Only commits touching this path")
    }, async ({ cwd, limit, path: filePath }) => {
        log("git log", cwd || "");
        const args = ["log", "-n", String(limit), "--pretty=format:%h %ad %an: %s", "--date=short"];
        if (filePath) args.push("--", filePath);
        return runGit(args, assertAllowed(cwd || process.cwd()));
    });

    defineTool("gitBranch", "List, create or switch branches", {
        cwd: z.string().optional().describe("Repository directory (defaults to server cwd)"),
        action: z.enum(["list", "create", "switch"]).optional().default("list").describe("What to do"),
        name: z.string().optional().describe("Branch name (required for create/switch)")
    }, async ({ cwd, action, name }) => {
        log("git branch", action, name || "");
        const repoCwd = assertAllowed(cwd || process.cwd());
        if (action === "list") return runGit(["branch", "-a", "-v"], repoCwd);
        if (!name) return err(`Branch name is required for action "${action}"`);
        if (action === "create") return runGit(["checkout", "-b", name], repoCwd);
        return runGit(["checkout", name], repoCwd);
    });

    defineTool("gitShow", "Show a commit (message + diff)", {
        cwd: z.string().optional().describe("Repository directory (defaults to server cwd)"),
        ref: z.string().optional().default("HEAD").describe("Commit ref (hash, tag, HEAD~1, ...)"),
        statOnly: z.boolean().optional().default(false).describe("Show only the change summary, not the full diff")
    }, async ({ cwd, ref, statOnly }) => {
        log("git show", ref);
        const args = statOnly ? ["show", "--stat", ref] : ["show", ref];
        return runGit(args, assertAllowed(cwd || process.cwd()));
    });
}
