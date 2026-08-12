import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { CampStore } from "./store.js";
import { getCampPaths } from "./paths.js";
import { syncProjectBackends, syncProjectSources } from "./sync.js";
import { startLocalModelServer } from "./models.js";
import { startRpcServer, rpcEndpoint } from "./rpc.js";
import { CampService } from "./service.js";
import { bootstrapDatabase } from "./bootstrap.js";
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function lockOwnsLiveRuntime(pid) {
    if (!processAlive(pid))
        return false;
    const paths = getCampPaths();
    const endpointDescriptor = join(paths.runtimeDir, "rpc-endpoint.json");
    // A PID alone is not an owner identity: operating systems can reuse it
    // after a crashed daemon. A healthy daemon must expose either its Unix
    // socket/named pipe or its file/loopback endpoint. A fresh lock without
    // either endpoint is still stale; acquisition itself is atomic, so a
    // concurrent launch cannot be stolen between the unlink and open("wx").
    if (existsSync(rpcEndpoint()) || existsSync(endpointDescriptor))
        return true;
    return false;
}
function acquireLock() {
    const path = getCampPaths().daemonLock;
    if (existsSync(path)) {
        const pid = Number(readFileSync(path, "utf8").trim());
        if (Number.isFinite(pid) && lockOwnsLiveRuntime(pid)) {
            throw new Error(`CAMP daemon is already running with PID ${pid}`);
        }
        unlinkSync(path);
    }
    const descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, String(process.pid));
    return { path, descriptor };
}
function logError(input) {
    const system = input.error;
    process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        component: input.component,
        operation: input.operation,
        projectId: input.projectId ?? null,
        source: input.source ?? null,
        path: input.path ?? null,
        message: input.error instanceof Error ? input.error.message : String(input.error),
        code: typeof system?.code === "string" ? system.code : null,
        errno: typeof system?.errno === "number" ? system.errno : null,
        syscall: typeof system?.syscall === "string" ? system.syscall : null,
        stack: process.env.CAMP_DEBUG === "1" && input.error instanceof Error ? input.error.stack : undefined,
    })}\n`);
}
export class SerialQueue {
    pending = [];
    idleWaiters = [];
    running = false;
    run(operation) {
        const result = new Promise((resolve, reject) => {
            this.pending.push({
                operation,
                resolve: resolve,
                reject,
            });
        });
        void this.pump();
        return result;
    }
    async executeNext() {
        const item = this.pending.shift();
        if (!item)
            return;
        try {
            item.resolve(await item.operation());
        }
        catch (error) {
            item.reject(error);
        }
    }
    settleIdle() {
        if (this.running || this.pending.length)
            return;
        for (const resolve of this.idleWaiters.splice(0))
            resolve();
    }
    async pump() {
        if (this.running)
            return;
        this.running = true;
        try {
            while (this.pending.length)
                await this.executeNext();
        }
        finally {
            this.running = false;
            this.settleIdle();
            // A job can arrive between the final length check and clearing running.
            if (this.pending.length)
                void this.pump();
        }
    }
    /**
     * A long background sync calls this at restartable boundaries. Requests
     * already waiting in the same FIFO are completed before the background
     * continuation resumes, so a multi-gigabyte initial import cannot starve a
     * receipt behind an entire project scan.
     */
    async cooperate() {
        await new Promise((resolve) => setImmediate(resolve));
        while (this.pending.length) {
            await this.executeNext();
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    drain() {
        if (!this.running && !this.pending.length)
            return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }
}
// These operations never mutate CAMP's canonical SQLite database. Serving
// them outside the writer FIFO keeps diagnostics and existing memory usable
// while a large first import is running. better-sqlite3 calls remain
// synchronous on this process's event loop, so a read cannot interleave with
// the middle of a daemon-owned transaction.
const READ_ONLY_RPC_METHODS = new Set([
    "status",
    "doctor",
    "search",
    "conversation",
    "contextStatus",
    "listProjects",
]);
export async function runDaemon(intervalMs = 60_000) {
    await bootstrapDatabase();
    const lock = acquireLock();
    let store;
    try {
        store = new CampStore();
        store.recoverInterruptedSyncs();
    }
    catch (error) {
        closeSync(lock.descriptor);
        if (existsSync(lock.path))
            unlinkSync(lock.path);
        throw error;
    }
    const queue = new SerialQueue();
    const localModelServer = startLocalModelServer();
    const pendingProjects = new Set();
    let fullSyncRequested = false;
    let nextFullSyncAt = Date.now();
    let stopping = false;
    let lastClientActivity = Date.now();
    const idleMs = Math.max(0, Number(process.env.CAMP_DAEMON_IDLE_MS ?? 0));
    let wake = null;
    const stop = () => {
        stopping = true;
        wake?.();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const requestFastSync = (projectId) => {
        if (projectId)
            pendingProjects.add(projectId);
        else
            fullSyncRequested = true;
        wake?.();
    };
    const service = new CampService(store, requestFastSync);
    let rpc = null;
    try {
        rpc = await startRpcServer(async (method, params, client) => {
            lastClientActivity = Date.now();
            if (method === "ping")
                return { ok: true, pid: process.pid };
            if (method === "shutdown") {
                stop();
                return { stopping: true };
            }
            if (READ_ONLY_RPC_METHODS.has(method))
                return service.call(method, params, client);
            return queue.run(() => service.call(method, params, client));
        });
        // Advertise RPC readiness before the first potentially expensive history
        // scan. This prevents launchd/systemd startup probes from spawning a
        // duplicate daemon while the single writer is legitimately busy.
        await new Promise((resolve) => setTimeout(resolve, 250));
        // Hooks already arrive through authenticated RPC and request one exact
        // project sync at lifecycle boundaries. Watching CAMP's own hook spool
        // caused every PostToolUse append to launch another full scan. Cursor and
        // native SQLite sources remain covered by the bounded 60-second poll.
        while (!stopping) {
            const now = Date.now();
            const fullScan = fullSyncRequested || now >= nextFullSyncAt;
            const scheduledFullScan = fullScan;
            let projects;
            if (fullScan) {
                projects = store.listProjects();
                fullSyncRequested = false;
                pendingProjects.clear();
                // Do not let a slow initial cycle immediately trigger another complete
                // cycle merely because its runtime exceeded the poll interval. That
                // starves receipt and acknowledgment RPC calls behind continuous sync
                // work. Context issuance still refreshes an exact project on demand
                // whenever its successful-source freshness exceeds the 120s gate.
                nextFullSyncAt = Number.POSITIVE_INFINITY;
            }
            else if (pendingProjects.size) {
                const requested = new Set(pendingProjects);
                pendingProjects.clear();
                projects = store.listProjects().filter((project) => requested.has(project.id));
            }
            else {
                if (idleMs && Date.now() - lastClientActivity >= idleMs)
                    break;
                await new Promise((resolve) => {
                    let settled = false;
                    const untilPoll = Math.max(25, nextFullSyncAt - Date.now());
                    const untilIdle = idleMs
                        ? Math.max(25, idleMs - (Date.now() - lastClientActivity))
                        : untilPoll;
                    const timer = setTimeout(finish, Math.min(untilPoll, untilIdle));
                    function finish() {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        wake = null;
                        resolve();
                    }
                    wake = finish;
                });
                continue;
            }
            // Refresh every selected project's native sources before running any
            // optional backend enrichment. A slow ChatCrystal, Memorix, or Ollama
            // operation for project A must not age project B's source receipt.
            const importsByProject = new Map();
            for (const project of projects) {
                try {
                    const imports = await queue.run(() => syncProjectSources(store, project, undefined, () => queue.cooperate()));
                    importsByProject.set(project.id, imports);
                    for (const summary of imports) {
                        for (const detail of summary.errorDetails ?? []) {
                            logError({
                                component: "importer",
                                operation: detail.phase,
                                projectId: project.id,
                                source: summary.source,
                                path: detail.path,
                                error: Object.assign(new Error(detail.message), {
                                    code: detail.code ?? undefined,
                                    errno: detail.errno ?? undefined,
                                    syscall: detail.syscall ?? undefined,
                                }),
                            });
                        }
                    }
                }
                catch (error) {
                    importsByProject.set(project.id, []);
                    logError({ component: "sync", operation: "sources", projectId: project.id, error });
                }
            }
            for (const project of projects) {
                try {
                    await queue.run(() => syncProjectBackends(store, project, importsByProject.get(project.id) ?? [], () => queue.cooperate()));
                }
                catch (error) {
                    logError({ component: "sync", operation: "backends", projectId: project.id, error });
                }
            }
            if (scheduledFullScan)
                nextFullSyncAt = Date.now() + intervalMs;
            if (stopping)
                break;
            if (idleMs && Date.now() - lastClientActivity >= idleMs)
                break;
        }
    }
    finally {
        stopping = true;
        await queue.drain();
        if (rpc)
            await new Promise((resolve) => rpc?.close(() => resolve()));
        const endpoint = rpcEndpoint();
        if (process.platform !== "win32" && existsSync(endpoint))
            unlinkSync(endpoint);
        const descriptor = join(store.paths.runtimeDir, "rpc-endpoint.json");
        if (existsSync(descriptor))
            unlinkSync(descriptor);
        // Keep the writer lock until SQLite is fully closed. On POSIX an open
        // database can be unlinked, which masked the race; Windows correctly
        // rejects the deletion. The lock is also the signal used by upgrade and
        // test callers, so releasing it only after the handle closes is the
        // accurate lifecycle boundary on every host.
        store.close();
        closeSync(lock.descriptor);
        if (existsSync(lock.path))
            unlinkSync(lock.path);
        if (localModelServer && !localModelServer.killed)
            localModelServer.kill("SIGTERM");
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
    }
}
//# sourceMappingURL=daemon.js.map