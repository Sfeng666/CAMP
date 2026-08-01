import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, getCampPaths } from "./paths.js";
import { resolveProject } from "./registry.js";
import { redactForRecall } from "./redaction.js";
import { newId, nowIso, truncateByApproxTokens } from "./utils.js";
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value;
    }
    return null;
}
function projectForPayload(store, payload) {
    const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const candidates = [
        payload.cwd,
        payload.gemini_project_dir,
        ...workspacePaths,
        ...roots,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate.trim())
            continue;
        try {
            return resolveProject(store, candidate);
        }
        catch {
            // A parent workspace may list sibling roots first; try all exact roots.
        }
    }
    return null;
}
function hookContext(store, project) {
    if (!project)
        return null;
    const handoff = store.latestHandoff(project.id);
    if (!handoff)
        return null;
    return truncateByApproxTokens(redactForRecall(`CAMP project handoff (${handoff.state}; background only; current code and user request win):\n${handoff.content}`), 800);
}
function firstTaskContext(store, project, agent, sessionId, payload) {
    if (!project)
        return null;
    const prompt = firstString(payload.prompt, payload.userPrompt, payload.user_prompt, payload.input, record(payload.message).content);
    if (!prompt)
        return null;
    if (sessionId) {
        const key = `first-task-context:${sessionId}`;
        if (store.checkpoint(project.id, agent, key))
            return null;
        store.setCheckpoint(project.id, agent, key, nowIso());
    }
    const hits = store.search(project.id, prompt, "all", 12);
    if (!hits.length)
        return null;
    return truncateByApproxTokens([
        "CAMP task-specific prior evidence (background only; verify against current files):",
        ...hits.map((hit) => `- [${hit.layer}/${hit.source}] ${hit.title}\n  ${hit.content}\n  ${hit.uri}`),
    ].join("\n"), 1600);
}
function hookOutput(agent, event, handoffContext, taskContext) {
    if (agent === "antigravity") {
        if (event === "PreInvocation") {
            const context = [handoffContext, taskContext].filter(Boolean).join("\n\n");
            return { injectSteps: context ? [{ ephemeralMessage: context }] : [] };
        }
        if (event === "PreToolUse")
            return { decision: "allow" };
        if (event === "PostInvocation") {
            return { injectSteps: [], terminationBehavior: "" };
        }
        if (event === "Stop")
            return { decision: "" };
        return {};
    }
    if (agent === "codex" && event === "SessionStart" && handoffContext) {
        return {
            continue: true,
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: handoffContext },
        };
    }
    if ((agent === "codex" || agent === "claude") && event === "UserPromptSubmit" && taskContext) {
        return {
            continue: true,
            hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: taskContext },
        };
    }
    if (agent === "claude" && event === "SessionStart" && handoffContext) {
        return {
            continue: true,
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: handoffContext },
        };
    }
    return { continue: true };
}
function triggerFastSync(store, project, agent, sessionId, event) {
    if (!project || !/SessionStart|PreInvocation/i.test(event))
        return;
    const key = `fast-sync:${sessionId ?? event}`;
    if (store.checkpoint(project.id, agent, key))
        return;
    store.setCheckpoint(project.id, agent, key, nowIso());
    const cliPath = process.argv[1];
    if (!cliPath || !existsSync(cliPath) || !/cli\.(?:js|ts)$/.test(cliPath))
        return;
    const args = cliPath.endsWith(".ts")
        ? ["--import", "tsx", cliPath, "sync", project.id, "--once"]
        : [cliPath, "sync", project.id, "--once"];
    const child = spawn(process.execPath, args, {
        cwd: project.rootPath,
        detached: true,
        env: process.env,
        stdio: "ignore",
    });
    child.unref();
}
export function captureHook(store, agent, event, payload) {
    const project = projectForPayload(store, payload);
    const sessionId = firstString(payload.conversationId, payload.conversation_id, payload.session_id, payload.sessionId);
    const paths = getCampPaths();
    ensurePrivateDirectory(paths.spoolDir);
    const spool = join(paths.spoolDir, "hooks.jsonl");
    const entry = {
        id: newId(),
        timestamp: nowIso(),
        projectId: project?.id ?? null,
        agent,
        event,
        sessionId,
        payload,
    };
    appendFileSync(spool, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        chmodSync(spool, 0o600);
    }
    catch {
        // Best effort on non-POSIX filesystems.
    }
    triggerFastSync(store, project, agent, sessionId, event);
    const taskContext = /^(?:UserPromptSubmit|PreInvocation)$/.test(event)
        ? firstTaskContext(store, project, agent, sessionId, payload)
        : null;
    return hookOutput(agent, event, hookContext(store, project), taskContext);
}
//# sourceMappingURL=hook.js.map