import { createConnection, createServer, } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, closeSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bootstrapDatabase } from "./bootstrap.js";
import { ensureCampDirectories, ensurePrivateDirectory, ensurePrivateFile, getCampPaths, } from "./paths.js";
import { hostPlatform } from "./platform.js";
import { sha256 } from "./utils.js";
import { CAMP_VERSION } from "./version.js";
import { atomicWrite } from "./utils.js";
const MAX_FRAME = 4 * 1024 * 1024;
export function rpcEndpoint() {
    const paths = getCampPaths();
    return hostPlatform() === "windows"
        ? `\\\\.\\pipe\\camp-${sha256(paths.home).slice(0, 16)}`
        : join(paths.runtimeDir, "camp.sock");
}
function endpointDescriptor() {
    return join(getCampPaths().runtimeDir, "rpc-endpoint.json");
}
function connectionTarget() {
    const descriptor = endpointDescriptor();
    if (existsSync(descriptor)) {
        try {
            const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
            if (parsed.kind === "file" &&
                typeof parsed.requests === "string" &&
                typeof parsed.responses === "string") {
                return { kind: "file", requests: parsed.requests, responses: parsed.responses };
            }
            if (parsed.host === "127.0.0.1" && Number.isInteger(parsed.port) && Number(parsed.port) > 0) {
                return { kind: "tcp", host: parsed.host, port: Number(parsed.port) };
            }
        }
        catch {
            // A stale descriptor is ignored; the Unix socket/named pipe remains authoritative.
        }
    }
    return rpcEndpoint();
}
export function ensureRpcToken() {
    const paths = ensureCampDirectories(getCampPaths());
    if (!existsSync(paths.rpcToken)) {
        try {
            writeFileSync(paths.rpcToken, `${randomBytes(32).toString("hex")}\n`, {
                flag: "wx",
                mode: 0o600,
            });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    ensurePrivateFile(paths.rpcToken);
    const token = readFileSync(paths.rpcToken, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(token))
        throw new Error(`Invalid CAMP RPC token: ${paths.rpcToken}`);
    return token;
}
export function defaultRpcIdentity(deliveryMode = "cli") {
    return {
        name: deliveryMode === "cli" ? "camp-cli" : "camp",
        version: CAMP_VERSION,
        instanceId: randomUUID(),
        deliveryMode,
    };
}
function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function daemonOwnerPid() {
    const path = getCampPaths().daemonLock;
    if (!existsSync(path))
        return null;
    try {
        const pid = Number(readFileSync(path, "utf8").trim());
        return processAlive(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
export async function waitForDaemonExit(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let owner = daemonOwnerPid();
    while (owner && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        owner = daemonOwnerPid();
    }
    if (owner) {
        throw new Error(`CAMP daemon PID ${owner} did not release the writer lock within ${timeoutMs}ms`);
    }
}
function invocation() {
    const current = process.argv[1];
    if (current && current.endsWith(".ts")) {
        const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
        return { command: process.execPath, args: ["--import", loader, current, "daemon"] };
    }
    if (current)
        return { command: process.execPath, args: [current, "daemon"] };
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    return { command: process.execPath, args: [cli, "daemon"] };
}
async function rawCall(method, params, client, timeoutMs) {
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, token: ensureRpcToken(), method, params, client })}\n`;
    if (Buffer.byteLength(payload) > MAX_FRAME)
        throw new Error("CAMP RPC request exceeds the 4 MiB limit");
    const target = connectionTarget();
    if (typeof target !== "string" && target.kind === "file") {
        const requestPath = join(target.requests, `${id}.json`);
        const responsePath = join(target.responses, `${id}.json`);
        atomicWrite(requestPath, payload, 0o600);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (existsSync(responsePath)) {
                const raw = readFileSync(responsePath, "utf8");
                unlinkSync(responsePath);
                const response = JSON.parse(raw);
                if (response.error) {
                    const error = new Error(response.error.message);
                    if (response.error.code)
                        error.code = response.error.code;
                    throw error;
                }
                return response.result;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (existsSync(requestPath))
            unlinkSync(requestPath);
        throw new Error(`CAMP daemon file RPC timed out after ${timeoutMs}ms`);
    }
    return new Promise((resolve, reject) => {
        const socket = typeof target === "string"
            ? createConnection(target)
            : createConnection({ host: target.host, port: target.port });
        let buffer = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`CAMP daemon RPC timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(payload));
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > MAX_FRAME) {
                socket.destroy();
                clearTimeout(timer);
                reject(new Error("CAMP daemon RPC response exceeds the 4 MiB limit"));
                return;
            }
            const newline = buffer.indexOf("\n");
            if (newline < 0)
                return;
            const line = buffer.slice(0, newline);
            socket.end();
            clearTimeout(timer);
            try {
                const response = JSON.parse(line);
                if (response.id !== id)
                    throw new Error("CAMP daemon returned a mismatched RPC response");
                if (response.error) {
                    const error = new Error(response.error.message);
                    if (response.error.code)
                        error.code = response.error.code;
                    reject(error);
                }
                else {
                    resolve(response.result);
                }
            }
            catch (error) {
                reject(error);
            }
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
export async function rpcCall(method, params = {}, client = defaultRpcIdentity(), timeoutMs = method === "sync"
    ? 10 * 60_000
    : new Set([
        "setup",
        "context",
        "ackContext",
        "startVerification",
        "recordMemory",
        "createHandoff",
        "capture",
        "remove",
        "reindex",
    ]).has(method)
        ? 150_000
        : 30_000) {
    return (await rawCall(method, params, client, timeoutMs));
}
export async function ensureDaemon(startupWaitMs = 5_000) {
    ensureRpcToken();
    try {
        await rawCall("ping", {}, defaultRpcIdentity(), 750);
        return;
    }
    catch {
        // Bootstrap and spawn below.
    }
    let bootstrapped = false;
    let bootstrapError = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await bootstrapDatabase();
            bootstrapped = true;
            break;
        }
        catch (error) {
            bootstrapError = error;
            if (!/(?:still owns the pre-v\d+ database|schema migration is already owned|acquire the schema migration lock)/i.test(error instanceof Error ? error.message : String(error))) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    if (!bootstrapped)
        throw bootstrapError;
    // A service manager may have launched CAMP milliseconds ago, or a healthy
    // daemon may be inside one synchronous native-source query. Never spawn a
    // second process while a live owner lock exists.
    let liveOwner = null;
    const readinessDeadline = Date.now() + Math.max(1_000, startupWaitMs);
    while (Date.now() < readinessDeadline) {
        try {
            await rawCall("ping", {}, defaultRpcIdentity(), 1_000);
            return;
        }
        catch {
            liveOwner = daemonOwnerPid();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    if (liveOwner) {
        throw new Error(`CAMP daemon PID ${liveOwner} owns the database but did not answer its health probe`);
    }
    const target = invocation();
    const paths = getCampPaths();
    const stdout = openSync(join(paths.logDir, "daemon.log"), "a", 0o600);
    const stderr = openSync(join(paths.logDir, "daemon-error.log"), "a", 0o600);
    const child = spawn(target.command, target.args, {
        detached: true,
        env: { ...process.env, CAMP_DAEMON_CHILD: "1" },
        stdio: ["ignore", stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    child.unref();
    let last = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
            await rawCall("ping", {}, defaultRpcIdentity(), 500);
            return;
        }
        catch (error) {
            last = error;
        }
    }
    throw new Error(`CAMP daemon did not become ready: ${last instanceof Error ? last.message : String(last)}`);
}
export async function callDaemon(method, params = {}, client = defaultRpcIdentity(), timeoutMs) {
    // A live writer lock is the authoritative singleton signal. Send the real
    // request directly so a temporarily busy importer cannot fail a short
    // preliminary ping and cancel an otherwise valid MCP tool call.
    if (!daemonOwnerPid())
        await ensureDaemon();
    return rpcCall(method, params, client, timeoutMs);
}
function fileRpcServer(handler, token, descriptor) {
    const root = getCampPaths().runtimeDir;
    const requests = join(root, "rpc-requests");
    const responses = join(root, "rpc-responses");
    ensurePrivateDirectory(requests);
    ensurePrivateDirectory(responses);
    atomicWrite(descriptor, `${JSON.stringify({ kind: "file", requests, responses })}\n`, 0o600);
    const active = new Set();
    const timer = setInterval(() => {
        let names = [];
        try {
            names = readdirSync(requests).filter((entry) => entry.endsWith(".json"));
        }
        catch {
            return;
        }
        for (const name of names) {
            if (active.has(name))
                continue;
            active.add(name);
            void (async () => {
                const requestPath = join(requests, name);
                let request = null;
                try {
                    const raw = readFileSync(requestPath, "utf8");
                    if (Buffer.byteLength(raw) > MAX_FRAME)
                        throw Object.assign(new Error("RPC frame too large"), { code: "FRAME_TOO_LARGE" });
                    request = JSON.parse(raw);
                    if (request.token !== token)
                        throw Object.assign(new Error("CAMP RPC authentication failed"), { code: "UNAUTHORIZED" });
                    const result = await handler(request.method, request.params ?? {}, request.client);
                    atomicWrite(join(responses, name), `${JSON.stringify({ id: request.id, result })}\n`, 0o600);
                }
                catch (error) {
                    const system = error;
                    const response = {
                        id: request?.id ?? name.replace(/\.json$/, ""),
                        error: {
                            message: error instanceof Error ? error.message : String(error),
                            code: typeof system?.code === "string" ? system.code : null,
                        },
                    };
                    atomicWrite(join(responses, name), `${JSON.stringify(response)}\n`, 0o600);
                }
                finally {
                    if (existsSync(requestPath))
                        unlinkSync(requestPath);
                    active.delete(name);
                }
            })();
        }
    }, 10);
    timer.unref();
    return {
        close(callback) {
            clearInterval(timer);
            Promise.all([...active].map(async (name) => {
                while (active.has(name))
                    await new Promise((resolve) => setTimeout(resolve, 5));
            })).then(callback, callback);
        },
    };
}
export async function startRpcServer(handler) {
    const token = ensureRpcToken();
    const endpoint = rpcEndpoint();
    const descriptor = endpointDescriptor();
    if (existsSync(descriptor))
        unlinkSync(descriptor);
    if (process.env.CAMP_USER_HOME && getCampPaths().platform !== "windows" && process.env.CAMP_USER_HOME !== homedir()) {
        return fileRpcServer(handler, token, descriptor);
    }
    if (hostPlatform() !== "windows" && existsSync(endpoint))
        unlinkSync(endpoint);
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        // A caller may time out and close while a large importer temporarily owns
        // the JavaScript thread. Late replies must be dropped, never promoted to
        // an unhandled EPIPE that terminates the daemon.
        socket.on("error", () => undefined);
        const reply = (response) => {
            if (socket.destroyed || !socket.writable)
                return;
            socket.write(`${JSON.stringify(response)}\n`, (error) => {
                // The socket error listener above also consumes transport errors. The
                // callback prevents a late write failure from being left unobserved.
                if (error && !socket.destroyed)
                    socket.destroy();
            });
        };
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > MAX_FRAME) {
                reply({ id: "", error: { message: "RPC frame too large", code: "FRAME_TOO_LARGE" } });
                socket.end();
                return;
            }
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf("\n");
                void (async () => {
                    let request = null;
                    try {
                        request = JSON.parse(line);
                        if (request.token !== token) {
                            const unauthorized = {
                                id: request.id,
                                error: { message: "CAMP RPC authentication failed", code: "UNAUTHORIZED" },
                            };
                            reply(unauthorized);
                            return;
                        }
                        const result = await handler(request.method, request.params ?? {}, request.client);
                        reply({ id: request.id, result });
                    }
                    catch (error) {
                        const system = error;
                        const response = {
                            id: request?.id ?? "",
                            error: {
                                message: error instanceof Error ? error.message : String(error),
                                code: typeof system?.code === "string" ? system.code : null,
                            },
                        };
                        reply(response);
                    }
                })();
            }
        });
    });
    if (process.env.CAMP_RPC_FORCE_LOOPBACK === "1") {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("CAMP RPC forced loopback did not expose a port");
        }
        atomicWrite(descriptor, `${JSON.stringify({ host: "127.0.0.1", port: address.port })}\n`, 0o600);
        return server;
    }
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(endpoint, () => {
                server.off("error", reject);
                resolve();
            });
        });
        if (hostPlatform() !== "windows")
            ensurePrivateFile(endpoint);
    }
    catch (error) {
        const code = error.code;
        if (hostPlatform() === "windows" || !new Set(["EPERM", "EACCES", "EOPNOTSUPP"]).has(String(code))) {
            throw error;
        }
        try {
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        }
        catch (fallbackError) {
            const fallbackCode = fallbackError.code;
            if (!new Set(["EPERM", "EACCES", "EOPNOTSUPP"]).has(String(fallbackCode)))
                throw fallbackError;
            return fileRpcServer(handler, token, descriptor);
        }
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("CAMP RPC loopback fallback did not expose a port");
        atomicWrite(descriptor, `${JSON.stringify({ host: "127.0.0.1", port: address.port })}\n`, 0o600);
    }
    return server;
}
//# sourceMappingURL=rpc.js.map