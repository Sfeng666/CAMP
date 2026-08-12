import { opendir, open, readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { SCHEMA_VERSION } from "../types.js";
import { fileFingerprint, isInsidePath, nowIso, sha256, stableId, toStringContent } from "../utils.js";
import { redactForRecall } from "../redaction.js";
const TRANSIENT_READ_CODES = new Set(["EAGAIN", "EINTR", "EBUSY", "UNSTABLE_SNAPSHOT"]);
/**
 * Read just enough of a JSONL transcript to attribute it to a project before
 * paying the cost of parsing and hashing the complete file. The prefix is read
 * twice from a stable inode. Appends after the initial stat are allowed, but a
 * replacement, truncation, changed prefix, or incomplete final record is never
 * treated as stable evidence.
 */
export async function readJsonLinePrefix(path, maxBytes = 256 * 1024, maxLines = 64) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let descriptor = null;
        try {
            const before = await stat(path);
            if (!before.size)
                return [];
            const extent = Math.min(before.size, Math.max(1, maxBytes));
            descriptor = await open(path, "r");
            const first = Buffer.alloc(extent);
            const firstRead = await descriptor.read(first, 0, extent, 0);
            if (firstRead.bytesRead !== extent) {
                throw Object.assign(new Error("JSONL prefix changed before it could be read"), {
                    code: "UNSTABLE_SNAPSHOT",
                });
            }
            const second = Buffer.alloc(extent);
            const secondRead = await descriptor.read(second, 0, extent, 0);
            if (secondRead.bytesRead !== extent || !first.equals(second)) {
                throw Object.assign(new Error("JSONL prefix changed during project attribution"), {
                    code: "UNSTABLE_SNAPSHOT",
                });
            }
            const after = await stat(path);
            if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) {
                throw Object.assign(new Error("JSONL file was replaced or truncated during project attribution"), {
                    code: "UNSTABLE_SNAPSHOT",
                });
            }
            const complete = extent === before.size && first[extent - 1] === 0x0a;
            const lines = first.toString("utf8").split("\n");
            if (!complete)
                lines.pop();
            const entries = [];
            for (let index = 0; index < lines.length && entries.length < maxLines; index += 1) {
                const text = lines[index];
                if (!text?.trim())
                    continue;
                try {
                    const value = JSON.parse(text);
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        entries.push({ value: value, line: index + 1 });
                    }
                }
                catch (error) {
                    throw new Error(`Malformed JSONL record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return entries;
        }
        catch (error) {
            last = error;
            const code = String(error.code);
            if (!TRANSIENT_READ_CODES.has(code) || attempt === 2)
                throw error;
            await delay(25 * 2 ** attempt);
        }
        finally {
            await descriptor?.close().catch(() => undefined);
        }
    }
    throw last;
}
async function jsonlSnapshot(path) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let descriptor = null;
        try {
            const snapshot = await stat(path);
            if (!snapshot.size) {
                return {
                    size: 0,
                    dev: snapshot.dev,
                    ino: snapshot.ino,
                    mtimeMs: snapshot.mtimeMs,
                    terminated: true,
                };
            }
            descriptor = await open(path, "r");
            const tail = Buffer.alloc(1);
            const read = await descriptor.read(tail, 0, 1, snapshot.size - 1);
            if (read.bytesRead !== 1) {
                throw Object.assign(new Error("JSONL file changed before its snapshot extent could be read"), {
                    code: "UNSTABLE_SNAPSHOT",
                });
            }
            return {
                size: snapshot.size,
                dev: snapshot.dev,
                ino: snapshot.ino,
                mtimeMs: snapshot.mtimeMs,
                terminated: tail[0] === 0x0a,
            };
        }
        catch (error) {
            last = error;
            if (!TRANSIENT_READ_CODES.has(String(error.code)) || attempt === 2) {
                throw error;
            }
            await delay(25 * 2 ** attempt);
        }
        finally {
            await descriptor?.close().catch(() => undefined);
        }
    }
    throw last;
}
async function hashExtent(path, size) {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { start: 0, end: size - 1 });
    for await (const chunk of stream)
        hash.update(chunk);
    return hash.digest("hex");
}
export async function walkFiles(root, extensions, maxDepth = 8) {
    if (!existsSync(root))
        return [];
    const result = [];
    async function visit(directory, depth) {
        if (depth > maxDepth)
            return;
        let handle;
        try {
            handle = await opendir(directory);
        }
        catch {
            return;
        }
        for await (const entry of handle) {
            // Antigravity's documented transcript is nested in
            // `.system_generated/logs/transcript.jsonl`; keep all other hidden
            // directories excluded to avoid broad, accidental history scans.
            if (entry.name.startsWith(".") &&
                entry.name !== ".jsonl" &&
                entry.name !== ".system_generated")
                continue;
            const path = resolve(directory, entry.name);
            if (entry.isDirectory())
                await visit(path, depth + 1);
            else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase()))
                result.push(path);
        }
    }
    await visit(root, 0);
    return result.sort();
}
export async function readJsonLines(path, handler, cooperate = async () => undefined, yieldEvery = 1) {
    const snapshot = await jsonlSnapshot(path);
    if (!snapshot.size)
        return;
    let processed = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = createReadStream(path, {
            encoding: "utf8",
            start: 0,
            end: snapshot.size - 1,
        });
        const snapshotHash = createHash("sha256");
        stream.on("data", (chunk) => {
            snapshotHash.update(chunk);
        });
        const reader = createInterface({ input: stream, crlfDelay: Infinity });
        let line = 0;
        let pending = null;
        try {
            const dispatch = async (entry) => {
                if (entry.line <= processed || !entry.text.trim())
                    return;
                try {
                    const value = JSON.parse(entry.text);
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        await handler(value, entry.line);
                    }
                }
                catch (error) {
                    throw new Error(`Malformed JSONL record at line ${entry.line}: ${error instanceof Error ? error.message : String(error)}`);
                }
                processed = entry.line;
                // Native transcripts can contain many megabytes of tool output. Yield
                // at deterministic record boundaries so an active source import never
                // monopolizes the daemon's single writer or its health socket.
                if (processed % Math.max(1, yieldEvery) === 0)
                    await cooperate();
            };
            for await (const text of reader) {
                line += 1;
                if (pending)
                    await dispatch(pending);
                pending = { text, line };
            }
            if (pending && snapshot.terminated)
                await dispatch(pending);
            let after;
            try {
                after = await stat(path);
            }
            catch (error) {
                throw Object.assign(new Error("JSONL file disappeared during its bounded snapshot read"), {
                    code: "UNSTABLE_SNAPSHOT",
                    cause: error,
                });
            }
            const replaced = after.dev !== snapshot.dev || after.ino !== snapshot.ino;
            const truncated = after.size < snapshot.size;
            const rewrittenAtSameExtent = after.size === snapshot.size && after.mtimeMs !== snapshot.mtimeMs;
            if (replaced || truncated || rewrittenAtSameExtent) {
                throw Object.assign(new Error("JSONL file changed inside the initial snapshot extent; checkpoint was not advanced"), { code: "UNSTABLE_SNAPSHOT" });
            }
            const stableHash = await hashExtent(path, snapshot.size);
            if (snapshotHash.digest("hex") !== stableHash) {
                throw Object.assign(new Error("JSONL file changed while CAMP verified the initial snapshot extent; checkpoint was not advanced"), { code: "UNSTABLE_SNAPSHOT" });
            }
            return;
        }
        catch (error) {
            const code = error.code;
            if (!TRANSIENT_READ_CODES.has(String(code)) || attempt === 2)
                throw error;
            await delay(25 * 2 ** attempt);
        }
        finally {
            reader.close();
            stream.destroy();
        }
    }
}
export function importErrorDetail(source, phase, error, path = null) {
    const system = error && typeof error === "object" ? error : null;
    return {
        source,
        phase,
        path: path ? redactForRecall(path).slice(0, 4_096) : null,
        message: redactForRecall(error instanceof Error ? error.message : String(error)).slice(0, 4_096),
        code: typeof system?.code === "string" ? system.code : null,
        errno: typeof system?.errno === "number" ? system.errno : null,
        syscall: typeof system?.syscall === "string" ? system.syscall : null,
        observedAt: nowIso(),
    };
}
export function projectMatch(cwd, project) {
    if (!cwd)
        return "unknown";
    try {
        const candidate = resolve(cwd);
        const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
        if (isInsidePath(resolved, project.rootPath))
            return "exact";
        if (isInsidePath(project.rootPath, resolved))
            return "parent";
        return "unrelated";
    }
    catch {
        return "unknown";
    }
}
export function timestamp(value, fallback = nowIso()) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const millis = value < 10_000_000_000 ? value * 1000 : value;
        return new Date(millis).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && /^\d+$/.test(value.trim()))
            return timestamp(numeric, fallback);
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime()))
            return parsed.toISOString();
    }
    return fallback;
}
export function normalizeRole(value) {
    const role = String(value ?? "").toLowerCase();
    if (role === "user" || role === "human")
        return "user";
    if (role === "assistant" || role === "agent" || role === "ai")
        return "assistant";
    if (role === "system" || role === "developer")
        return "system";
    if (role === "tool" || role === "function")
        return "tool";
    return "unknown";
}
export function message(sequence, input) {
    const content = toStringContent(input.content).trim();
    if (!content)
        return null;
    return {
        id: input.id ?? stableId(sequence, content.slice(0, 256)),
        sequence,
        role: normalizeRole(input.role),
        kind: input.kind ?? "message",
        content,
        timestamp: timestamp(input.timestamp),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
    };
}
export function dedupeMessages(messages) {
    const seenIds = new Set();
    const seenContent = new Set();
    const output = [];
    for (const item of messages.sort((a, b) => a.sequence - b.sequence)) {
        if (seenIds.has(item.id))
            continue;
        const key = sha256(`${item.role}\n${item.kind}\n${item.content}\n${item.timestamp}`);
        if (seenContent.has(key))
            continue;
        seenIds.add(item.id);
        seenContent.add(key);
        output.push({ ...item, sequence: output.length });
    }
    return output;
}
export async function canonicalSession(input) {
    const messages = dedupeMessages(input.messages);
    const sourceStat = await stat(input.sourcePath).catch(() => null);
    const fallback = sourceStat?.mtime.toISOString() ?? nowIso();
    const lastMetadata = messages.at(-1)?.metadata;
    const sourceOffset = typeof lastMetadata?.sourceLine === "number" || typeof lastMetadata?.sourceLine === "string"
        ? lastMetadata.sourceLine
        : typeof lastMetadata?.sourceKey === "string"
            ? lastMetadata.sourceKey
            : null;
    return {
        schemaVersion: SCHEMA_VERSION,
        source: input.source,
        surface: input.surface ?? "unknown",
        ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
        nativeId: input.nativeId,
        projectId: input.project.id,
        projectRoot: input.project.rootPath,
        cwd: input.cwd,
        sourcePath: input.sourcePath,
        sourceFingerprint: sourceStat ? fileFingerprint(input.sourcePath) : sha256(input.sourcePath),
        startedAt: messages[0]?.timestamp ?? fallback,
        endedAt: messages.at(-1)?.timestamp ?? fallback,
        messages,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ingestionCheckpoint: { sourceOffset, importedAt: nowIso() },
        ...(input.metadata ? { metadata: input.metadata } : {}),
    };
}
export async function readText(path) {
    return readFile(path, "utf8");
}
//# sourceMappingURL=common.js.map