import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensurePrivateDirectory, ensurePrivateFile } from "../paths.js";
import { nowIso } from "../utils.js";
import { redactForRecall } from "../redaction.js";
import { cooperativeAwait } from "../utils.js";
export const CHATCRYSTAL_BASELINE = "0.5.8";
const emptyResult = () => ({
    total: 0,
    imported: 0,
    replaced: 0,
    skipped: 0,
    errors: 0,
    errorIds: [],
    items: [],
});
function workerInvocation(mode, projectId) {
    const current = fileURLToPath(import.meta.url);
    if (current.endsWith(".ts")) {
        const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
        const worker = fileURLToPath(new URL("./chatcrystal-worker.ts", import.meta.url));
        return {
            command: process.execPath,
            // --import consumes an ESM specifier, not a command-line filesystem
            // path. A file URL keeps this child process valid on Windows drive
            // letters while the worker entrypoint remains a normal native path.
            args: ["--import", pathToFileURL(loader).href, worker, mode, ...(projectId ? [projectId] : [])],
        };
    }
    const worker = fileURLToPath(new URL("./chatcrystal-worker.js", import.meta.url));
    return { command: process.execPath, args: [worker, mode, ...(projectId ? [projectId] : [])] };
}
async function runWorker(input) {
    const invocation = workerInvocation(input.mode, input.projectId);
    const child = spawn(invocation.command, invocation.args, {
        env: { ...process.env, DATA_DIR: input.dataDir, CAMP_CHATCRYSTAL_WORKER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let streamError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 2 * 1024 * 1024)
            child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024)
            stderr += chunk;
    });
    child.stdin.on("error", (error) => {
        streamError = error;
    });
    const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    try {
        if (input.records) {
            for await (const line of input.records) {
                if (!child.stdin.write(`${line}\n`)) {
                    await Promise.race([
                        once(child.stdin, "drain"),
                        completed.then(() => {
                            throw streamError ?? new Error("ChatCrystal worker closed its input early");
                        }),
                    ]);
                }
            }
        }
        child.stdin.end();
        const status = await completed;
        if (streamError)
            throw streamError;
        if (status !== 0) {
            throw new Error(redactForRecall(stderr.trim() || `ChatCrystal worker exited ${status}`).slice(0, 64 * 1024));
        }
        return JSON.parse(stdout);
    }
    finally {
        clearTimeout(timer);
        if (!child.killed && child.exitCode === null)
            child.kill("SIGTERM");
    }
}
export async function syncChatCrystal(store, project, cooperate = async () => undefined) {
    const dataDir = join(store.paths.backendDir, "chatcrystal");
    ensurePrivateDirectory(dataDir);
    const checkpointKey = "chatcrystal:last-success";
    const checkpoint = store.checkpoint(project.id, "archive", checkpointKey);
    const ids = store.listSessionIdsSince(project.id, checkpoint || null);
    if (!ids.length) {
        store.setCheckpoint(project.id, "archive", checkpointKey, nowIso());
        ensurePrivateFile(join(dataDir, "chatcrystal.db"));
        return emptyResult();
    }
    async function* records() {
        for (const id of ids) {
            const archive = store.sessionArchiveInfo(id, project.id);
            if (!archive || archive.messageCount < 2 || !existsSync(archive.archivePath))
                continue;
            yield JSON.stringify({
                archivePath: archive.archivePath,
                project,
                sourceInfo: store.sourceFileInfo(archive.sourcePath),
            });
            // The worker reads and decompresses the content-addressed archive. The
            // daemon sends only this small descriptor and remains responsive even
            // when one conversation contains tens of megabytes of tool output.
            await cooperate();
        }
    }
    const result = (await cooperativeAwait(runWorker({ mode: "ingest", dataDir, records: records() }), cooperate));
    if (!result.errors)
        store.setCheckpoint(project.id, "archive", checkpointKey, nowIso());
    ensurePrivateFile(join(dataDir, "chatcrystal.db"));
    return result;
}
export async function purgeChatCrystalProject(store, project) {
    const dataDir = join(store.paths.backendDir, "chatcrystal");
    ensurePrivateDirectory(dataDir);
    if (!existsSync(join(dataDir, "chatcrystal.db")))
        return { deleted: 0 };
    const result = (await runWorker({
        mode: "purge",
        dataDir,
        projectId: project.id,
    }));
    // A later re-registration can safely repopulate only this exact project.
    store.setCheckpoint(project.id, "archive", "chatcrystal:last-success", "");
    ensurePrivateFile(join(dataDir, "chatcrystal.db"));
    return result;
}
//# sourceMappingURL=chatcrystal.js.map