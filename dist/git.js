import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "./utils.js";
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
function gitStatus(projectRoot) {
    const result = spawnSync("git", ["-C", projectRoot, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0)
        return null;
    return result.stdout || null;
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
    const requested = realpathSync(resolve(inputPath));
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
    const status = gitStatus(projectRoot);
    const head = git(projectRoot, ["rev-parse", "HEAD"]);
    if (status === null && head === null)
        return null;
    return sha256(`${head ?? "no-head"}\n${status ?? ""}`);
}
export function currentCommit(projectRoot) {
    return git(projectRoot, ["rev-parse", "HEAD"]);
}
export function changedPaths(projectRoot) {
    const status = gitStatus(projectRoot);
    if (!status)
        return [];
    const fields = status.split("\0").filter(Boolean);
    const paths = [];
    for (let index = 0; index < fields.length; index += 1) {
        const entry = fields[index] ?? "";
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        if (path)
            paths.push(path);
        if (/[RC]/.test(code))
            index += 1;
    }
    return paths;
}
//# sourceMappingURL=git.js.map