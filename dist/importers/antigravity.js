import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getCampPaths } from "../paths.js";
import { antigravityRoots, userHome } from "../platform.js";
import { isInsidePath, stableId } from "../utils.js";
import { canonicalSession, message, readJsonLines, walkFiles } from "./common.js";
function quotedIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function databaseMentionsProject(path, project) {
    let db = null;
    try {
        db = new Database(path, { readonly: true, fileMustExist: true, timeout: 3000 });
        db.pragma("query_only = ON");
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all();
        for (const { name } of tables) {
            const columns = db.prepare(`PRAGMA table_info(${quotedIdentifier(name)})`).all();
            for (const column of columns) {
                const sql = `SELECT 1 FROM ${quotedIdentifier(name)} WHERE instr(CAST(${quotedIdentifier(column.name)} AS TEXT), ?) > 0 LIMIT 1`;
                if (db.prepare(sql).get(project.rootPath))
                    return true;
            }
        }
    }
    catch {
        return false;
    }
    finally {
        db?.close();
    }
    return false;
}
async function importHookSpool(store, project, summary) {
    const path = join(getCampPaths().spoolDir, "hooks.jsonl");
    if (!existsSync(path))
        return;
    const grouped = new Map();
    await readJsonLines(path, (entry, line) => {
        if (entry.projectId !== project.id || entry.agent !== "antigravity")
            return;
        const payload = entry.payload && typeof entry.payload === "object"
            ? entry.payload
            : {};
        const sessionId = String(entry.sessionId ?? payload.conversationId ?? payload.session_id ?? "antigravity-hook");
        const list = grouped.get(sessionId) ?? [];
        const event = String(entry.event ?? payload.hook_event_name ?? "event");
        let role = "system";
        let kind = "event";
        let content = payload;
        if (/preinvocation|beforeagent|beforemodel|prompt/i.test(event)) {
            role = "user";
            kind = "message";
            content = payload.prompt ?? payload.userPrompt ?? payload.input ?? payload;
        }
        else if (/postinvocation|afteragent|aftermodel|response/i.test(event)) {
            role = "assistant";
            kind = "message";
            content = payload.response ?? payload.output ?? payload.message ?? payload;
        }
        else if (/tool/i.test(event)) {
            role = "tool";
            kind = /post|after/i.test(event) ? "tool-result" : "tool-call";
            content = payload.tool_response ?? payload.tool_result ?? payload.toolCall ?? payload;
        }
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
        const item = message(list.length, {
            id: String(entry.id ?? `${sessionId}:${line}`),
            role,
            kind,
            content,
            timestamp: entry.timestamp,
            ...(toolName ? { toolName } : {}),
            metadata: { event, sourceLine: line },
        });
        if (item)
            list.push(item);
        grouped.set(sessionId, list);
    });
    for (const [nativeId, messages] of grouped) {
        if (!messages.length)
            continue;
        summary.scanned += 1;
        const session = await canonicalSession({
            source: "antigravity",
            surface: "unknown",
            sourceVersion: "antigravity-hook@1",
            nativeId,
            project,
            cwd: project.rootPath,
            sourcePath: path,
            messages,
        });
        const result = store.storeSession(session);
        summary[result.status] += 1;
    }
}
function transcriptWorkspacePaths(entry) {
    const values = [
        entry.workspacePaths,
        entry.workspacePath,
        entry.cwd,
        entry.projectPath,
        entry.payload && typeof entry.payload === "object"
            ? entry.payload.workspacePaths
            : null,
    ];
    return values.flatMap((value) => {
        if (typeof value === "string")
            return [value];
        if (Array.isArray(value))
            return value.filter((item) => typeof item === "string");
        return [];
    });
}
function transcriptMessage(entry, sequence, sourceLine) {
    const payload = entry.payload && typeof entry.payload === "object"
        ? entry.payload
        : entry;
    const type = String(entry.type ?? payload.type ?? entry.event ?? "").toLowerCase();
    const role = entry.role ?? payload.role ?? (/tool/.test(type) ? "tool" : /user|prompt|invocation/.test(type) ? "user" : /assistant|agent|response/.test(type) ? "assistant" : "unknown");
    const kind = /tool/.test(type)
        ? /result|output|post|after/.test(type) ? "tool-result" : "tool-call"
        : "message";
    const id = typeof entry.id === "string" ? entry.id : typeof payload.id === "string" ? payload.id : undefined;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    return message(sequence, {
        ...(id ? { id } : {}),
        role,
        kind,
        ...(toolName ? { toolName } : {}),
        content: payload.content ?? payload.message ?? payload.text ?? payload.prompt ?? payload.response ?? payload.output,
        timestamp: entry.timestamp ?? payload.timestamp ?? entry.createdAt ?? payload.createdAt,
        metadata: { sourceLine, transcriptFormat: "antigravity-transcript@1", type: type || null },
    });
}
async function importNativeTranscripts(store, project, summary, roots = antigravityRoots()) {
    for (const root of roots) {
        if (!existsSync(root))
            continue;
        const surface = /antigravity-cli/.test(root) ? "cli" : /antigravity[\\/]brain/.test(root) ? "desktop" : "unknown";
        const transcripts = (await walkFiles(root, [".jsonl"], 9)).filter((path) => basename(path) === "transcript.jsonl");
        for (const path of transcripts) {
            summary.scanned += 1;
            const messages = [];
            const paths = new Set();
            let conversationId = basename(dirname(path));
            await readJsonLines(path, (entry, sourceLine) => {
                for (const workspace of transcriptWorkspacePaths(entry))
                    paths.add(resolve(workspace));
                const payload = entry.payload && typeof entry.payload === "object"
                    ? entry.payload
                    : {};
                if (typeof entry.conversationId === "string")
                    conversationId = entry.conversationId;
                else if (typeof payload.conversationId === "string")
                    conversationId = payload.conversationId;
                const item = transcriptMessage(entry, messages.length, sourceLine);
                if (item)
                    messages.push(item);
            });
            const exact = [...paths].some((workspace) => isInsidePath(workspace, project.rootPath));
            const parent = [...paths].some((workspace) => isInsidePath(project.rootPath, workspace));
            if (!exact) {
                if (parent) {
                    store.addQuarantine({
                        projectId: project.id,
                        source: "antigravity",
                        sourcePath: path,
                        nativeId: conversationId,
                        reason: "Antigravity transcript belongs to a parent workspace; explicit project assignment is required",
                        metadata: { workspacePaths: [...paths] },
                    });
                    summary.quarantined += 1;
                }
                continue;
            }
            if (!messages.length) {
                store.addQuarantine({
                    projectId: project.id,
                    source: "antigravity",
                    sourcePath: path,
                    nativeId: conversationId,
                    reason: "Antigravity transcript matches this project but has an unsupported JSONL schema",
                    metadata: { adapter: "antigravity-transcript@1" },
                });
                summary.quarantined += 1;
                continue;
            }
            const nativeId = `antigravity-${surface}:${conversationId}`;
            const checkpoint = stableId(path, nativeId);
            const sourceFingerprint = messages.map((item) => `${item.id}:${item.content}`).join("\n");
            if (store.checkpoint(project.id, "antigravity", checkpoint) === sourceFingerprint) {
                summary.skipped += 1;
                continue;
            }
            const session = await canonicalSession({
                source: "antigravity",
                surface,
                sourceVersion: "antigravity-transcript@1",
                nativeId,
                project,
                cwd: project.rootPath,
                sourcePath: path,
                messages,
                metadata: { workspacePaths: [...paths], adapter: "antigravity-transcript@1" },
            });
            const result = store.storeSession(session);
            summary[result.status] += 1;
            store.setCheckpoint(project.id, "antigravity", checkpoint, sourceFingerprint);
        }
    }
}
export async function importAntigravity(store, project, root = process.env.ANTIGRAVITY_DATA_DIR ?? join(userHome(), ".gemini", "antigravity-ide")) {
    const summary = {
        source: "antigravity",
        scanned: 0,
        imported: 0,
        replaced: 0,
        skipped: 0,
        quarantined: 0,
        errors: [],
    };
    await importHookSpool(store, project, summary);
    await importNativeTranscripts(store, project, summary);
    if (!existsSync(root))
        return summary;
    for (const path of await walkFiles(root, [".db", ".sqlite", ".sqlite3"], 8)) {
        summary.scanned += 1;
        if (!databaseMentionsProject(path, project))
            continue;
        store.addQuarantine({
            projectId: project.id,
            source: "antigravity",
            sourcePath: path,
            nativeId: basename(path),
            reason: "Antigravity database references this project but uses an unsupported protobuf trajectory schema",
            metadata: { adapter: "antigravity-sqlite-protobuf", status: "needs-versioned-decoder" },
        });
        summary.quarantined += 1;
    }
    return summary;
}
//# sourceMappingURL=antigravity.js.map