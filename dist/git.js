import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isInsidePath, sha256 } from "./utils.js";
const fileHashCache = new Map();
const WORKSPACE_SKIP_DIRECTORIES = new Set([
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
]);
function git(path, args) {
    const result = spawnSync("git", ["-C", path, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0)
        return null;
    const value = result.stdout.trim();
    return value || null;
}
function gitStatus(projectRoot, untracked = "normal") {
    const result = spawnSync("git", ["-C", projectRoot, "status", "--porcelain=v1", "-z", `--untracked-files=${untracked}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0)
        return null;
    return result.stdout || null;
}
function gitRaw(projectRoot, args) {
    const result = spawnSync("git", ["-C", projectRoot, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : null;
}
function statusEntries(status) {
    const fields = status.split("\0").filter(Boolean);
    const entries = [];
    for (let index = 0; index < fields.length; index += 1) {
        const entry = fields[index] ?? "";
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        if (path)
            entries.push({ code, path });
        if (/[RC]/.test(code)) {
            const paired = fields[index + 1];
            if (paired)
                entries.push({ code, path: paired });
            index += 1;
        }
    }
    return entries;
}
function statusPaths(status) {
    return [...new Set(statusEntries(status).map((entry) => entry.path))].sort();
}
function receiptStatusEntries(status) {
    return statusEntries(status).filter((entry) => !((entry.code === "??" &&
        (entry.path === ".specstory" || entry.path.startsWith(".specstory/"))) ||
        // SpecStory rewrites this tracked telemetry counter merely because an
        // agent received context. Ignore only its unstaged generated update;
        // a staged version (M / MM) remains receipt-bound through both status
        // and the index fingerprint.
        (entry.code === " M" && entry.path === ".specstory/statistics.json")));
}
function contentHash(path) {
    const before = lstatSync(path);
    const key = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = fileHashCache.get(key);
    if (cached)
        return cached;
    const descriptor = openSync(path, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytes = 0;
        while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, bytes));
        }
        const digest = hash.digest("hex");
        if (fileHashCache.size >= 20_000)
            fileHashCache.clear();
        fileHashCache.set(key, digest);
        return digest;
    }
    finally {
        closeSync(descriptor);
    }
}
function workspaceFingerprint(projectRoot) {
    const hash = createHash("sha256");
    let files = 0;
    let incomplete = false;
    let unstable = false;
    const visit = (directory) => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true })
                .filter((entry) => !WORKSPACE_SKIP_DIRECTORIES.has(entry.name))
                .sort((left, right) => left.name.localeCompare(right.name));
        }
        catch (error) {
            incomplete = true;
            hash.update(`unreadable:${directory}:${error.code ?? "error"}\n`);
            return;
        }
        for (const entry of entries) {
            if (files >= 50_000) {
                incomplete = true;
                return;
            }
            const absolute = resolve(directory, entry.name);
            const relative = absolute.slice(resolve(projectRoot).length + 1);
            if (entry.isDirectory()) {
                hash.update(`directory:${relative}\n`);
                visit(absolute);
                continue;
            }
            files += 1;
            const state = pathState(projectRoot, relative);
            if (/\tunstable$/.test(state))
                unstable = true;
            hash.update(`${state}\n`);
        }
    };
    visit(resolve(projectRoot));
    const digest = hash.digest("hex");
    if (unstable)
        return `unstable:${digest}`;
    if (incomplete)
        return `partial:${digest}`;
    return `workspace:${digest}`;
}
function pathState(projectRoot, relativePath) {
    const absolute = resolve(projectRoot, relativePath);
    if (!isInsidePath(absolute, projectRoot))
        return `${relativePath}\toutside`;
    try {
        const before = lstatSync(absolute);
        if (before.isSymbolicLink())
            return `${relativePath}\tsymlink\t${sha256(readlinkSync(absolute))}`;
        if (before.isDirectory())
            return `${relativePath}\tdirectory\t${before.size}:${before.mtimeMs}`;
        if (!before.isFile())
            return `${relativePath}\tother\t${before.mode}:${before.size}:${before.mtimeMs}`;
        const hash = contentHash(absolute);
        const after = lstatSync(absolute);
        if (before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs) {
            return `${relativePath}\tunstable`;
        }
        return `${relativePath}\tfile\t${after.mode}:${after.size}:${hash}`;
    }
    catch (error) {
        const code = error.code ?? "unavailable";
        return `${relativePath}\t${code}`;
    }
}
export function normalizeRemote(value) {
    let remote = value.trim().replace(/\\/g, "/");
    remote = remote.replace(/^git@([^:]+):/, "https://$1/");
    remote = remote.replace(/^ssh:\/\/git@/, "https://");
    remote = remote.replace(/\.git$/, "").replace(/\/$/, "");
    try {
        const url = new URL(remote);
        url.username = "";
        url.password = "";
        url.hash = "";
        url.search = "";
        return `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/, "");
    }
    catch {
        return remote.toLowerCase();
    }
}
function allRemotes(root) {
    const names = git(root, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? [];
    const values = names
        .map((name) => git(root, ["remote", "get-url", name]))
        .filter((value) => Boolean(value))
        .map(normalizeRemote);
    return [...new Set(values)].sort();
}
export function inspectProject(inputPath) {
    // Keep the lexical absolute path as an alias as well as the real path. On
    // macOS, for example, Cursor may persist `/private/tmp/...` while Node
    // resolves the same workspace through `/private/var/...`. Both names refer
    // to one filesystem identity and must resolve to one CAMP project.
    const requestedPath = resolve(inputPath);
    const requested = realpathSync(requestedPath);
    const requestedStat = statSync(requested);
    if (!requestedStat.isDirectory())
        throw new Error(`Project path is not a directory: ${requested}`);
    const gitRootValue = git(requested, ["rev-parse", "--show-toplevel"]);
    const gitRoot = gitRootValue ? realpathSync(gitRootValue) : null;
    const rootPath = gitRoot ?? requested;
    const rootStat = statSync(rootPath);
    const filesystemId = `${rootStat.dev}:${rootStat.ino}`;
    const gitCommonRaw = gitRoot ? git(gitRoot, ["rev-parse", "--git-common-dir"]) : null;
    const gitCommonDir = gitCommonRaw
        ? realpathSync(resolve(gitRoot ?? rootPath, gitCommonRaw))
        : null;
    const rootCommit = gitRoot ? git(gitRoot, ["rev-list", "--max-parents=0", "HEAD"]) : null;
    const remotes = gitRoot ? allRemotes(gitRoot) : [];
    const preferredRemote = remotes[0] ?? null;
    const chatcrystalKey = preferredRemote ?? `local/${basename(rootPath)}`;
    const memorixKey = gitRoot
        ? preferredRemote ?? `local/${basename(rootPath)}`
        : null;
    const aliases = [
        { kind: "path", value: rootPath, confidence: 1 },
        { kind: "filesystem", value: filesystemId, confidence: 1 },
        { kind: "chatcrystal", value: chatcrystalKey, confidence: 0.95 },
    ];
    if (requestedPath !== rootPath) {
        aliases.push({ kind: "path", value: requestedPath, confidence: 1 });
    }
    if (gitCommonDir)
        aliases.push({ kind: "git-common-dir", value: gitCommonDir, confidence: 1 });
    if (rootCommit)
        aliases.push({ kind: "root-commit", value: rootCommit, confidence: 0.55 });
    for (const remote of remotes)
        aliases.push({ kind: "remote", value: remote, confidence: 0.95 });
    if (memorixKey)
        aliases.push({ kind: "memorix", value: memorixKey, confidence: 0.95 });
    return {
        kind: gitRoot ? "git" : "workspace",
        rootPath,
        filesystemId,
        gitRoot,
        gitCommonDir,
        rootCommit,
        remotes,
        chatcrystalKey,
        memorixKey,
        aliases,
    };
}
export function worktreeFingerprint(projectRoot) {
    const status = gitStatus(projectRoot, "all");
    const head = git(projectRoot, ["rev-parse", "HEAD"]);
    if (status === null && head === null)
        return workspaceFingerprint(projectRoot);
    const index = gitRaw(projectRoot, ["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-ext-diff"]);
    // SpecStory writes an untracked Markdown mirror and one tracked, unstaged
    // statistics counter while the receiving agent acknowledges CAMP. Treat
    // only those known generated artifacts as observational noise; staged
    // SpecStory content still binds the receipt like every other project path.
    const entries = status ? receiptStatusEntries(status) : [];
    const paths = [...new Set(entries.map((entry) => entry.path))].sort();
    const normalizedStatus = entries
        .map((entry) => `${entry.code} ${entry.path}`)
        .sort()
        .join("\0");
    const manifest = paths.map((path) => pathState(projectRoot, path)).join("\n");
    const digest = sha256(`${head ?? "no-head"}\n${normalizedStatus}\n${index ?? ""}\n${manifest}`);
    return manifest.includes("\tunstable") ? `unstable:${digest}` : digest;
}
export function currentCommit(projectRoot) {
    return git(projectRoot, ["rev-parse", "HEAD"]);
}
export function changedPaths(projectRoot) {
    const status = gitStatus(projectRoot);
    if (!status)
        return [];
    return [...new Set(receiptStatusEntries(status).map((entry) => entry.path))].sort();
}
//# sourceMappingURL=git.js.map