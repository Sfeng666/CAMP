import { basename, join } from "node:path";
import { fileFingerprint, stableId } from "../utils.js";
import { userHome } from "../platform.js";
import { canonicalSession, message, projectMatch, readJsonLinePrefix, readJsonLines, walkFiles } from "./common.js";
async function parseClaudeMetadata(path) {
    let cwd = null;
    let nativeId = basename(path, ".jsonl");
    for (const { value: entry } of await readJsonLinePrefix(path)) {
        if (typeof entry.cwd === "string")
            cwd = entry.cwd;
        if (typeof entry.sessionId === "string")
            nativeId = entry.sessionId;
        if (cwd && nativeId !== basename(path, ".jsonl"))
            break;
    }
    return { cwd, nativeId };
}
export async function importClaude(store, project, root = process.env.CLAUDE_PROJECTS_DIR ?? join(userHome(), ".claude", "projects"), cooperate = async () => undefined) {
    const summary = {
        source: "claude",
        scanned: 0,
        imported: 0,
        replaced: 0,
        skipped: 0,
        quarantined: 0,
        errors: [],
    };
    for (const path of await walkFiles(root, [".jsonl"], 5)) {
        summary.scanned += 1;
        try {
            const checkpointKey = stableId(path);
            const fingerprint = fileFingerprint(path);
            if (store.checkpoint(project.id, "claude", checkpointKey) === fingerprint) {
                summary.skipped += 1;
                continue;
            }
            const metadata = await parseClaudeMetadata(path);
            const preflightMatch = projectMatch(metadata.cwd, project);
            if (preflightMatch === "unrelated") {
                store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
                continue;
            }
            const preflightAssigned = store.isSourceAssigned("claude", path, metadata.nativeId, project.id);
            if (preflightMatch === "parent" && !preflightAssigned) {
                store.addQuarantine({
                    projectId: project.id,
                    source: "claude",
                    sourcePath: path,
                    nativeId: metadata.nativeId,
                    reason: "Claude session is attached to a parent workspace; explicit project assignment is required",
                    metadata: { cwd: metadata.cwd, preflightOnly: true },
                });
                store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
                summary.quarantined += 1;
                continue;
            }
            let cwd = null;
            let nativeId = basename(path, ".jsonl");
            const messages = [];
            await readJsonLines(path, (entry, sourceLine) => {
                if (typeof entry.cwd === "string")
                    cwd = entry.cwd;
                if (typeof entry.sessionId === "string")
                    nativeId = entry.sessionId;
                const rawMessage = entry.message && typeof entry.message === "object"
                    ? entry.message
                    : entry;
                const type = String(entry.type ?? rawMessage.type ?? "");
                if (!new Set(["user", "assistant", "system", "message"]).has(type))
                    return;
                const id = typeof entry.uuid === "string" ? entry.uuid : undefined;
                const parentId = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
                const item = message(messages.length, {
                    ...(id ? { id } : {}),
                    ...(parentId ? { parentId } : {}),
                    role: rawMessage.role ?? type,
                    content: rawMessage.content ?? entry.content,
                    timestamp: entry.timestamp ?? entry.createdAt,
                    metadata: { sourceLine },
                });
                if (item)
                    messages.push(item);
            }, cooperate);
            const match = projectMatch(cwd, project);
            if (match === "unrelated" || match === "unknown") {
                // Negative attribution is a restartable result. If this transcript is
                // appended later its stat fingerprint changes and CAMP reevaluates it.
                store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
                continue;
            }
            const assigned = store.isSourceAssigned("claude", path, nativeId, project.id);
            if (match === "parent" && !assigned) {
                store.addQuarantine({
                    projectId: project.id,
                    source: "claude",
                    sourcePath: path,
                    nativeId,
                    reason: "Claude session is attached to a parent workspace; explicit project assignment is required",
                    metadata: { cwd, messages: messages.length },
                });
                store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
                summary.quarantined += 1;
                continue;
            }
            if (!messages.length) {
                store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
                continue;
            }
            const session = await canonicalSession({
                source: "claude",
                surface: "cli",
                sourceVersion: "claude-jsonl@1",
                nativeId,
                project,
                cwd,
                sourcePath: path,
                messages,
            });
            const result = await store.storeSessionAsync(session, cooperate);
            summary[result.status] += 1;
            store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
        }
        catch (error) {
            summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            await cooperate();
        }
    }
    return summary;
}
//# sourceMappingURL=claude.js.map