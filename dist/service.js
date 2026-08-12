import { basename, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { setupProject, resolveProject } from "./registry.js";
import { changedPaths } from "./git.js";
import { syncProject, syncProjectSources } from "./sync.js";
import { runDoctor } from "./doctor.js";
import { hybridSearch } from "./semantic.js";
import { archiveMemorixProjectRecords, prepareMemorixMigration, queueMemorix, } from "./backends/memorix.js";
import { purgeChatCrystalProject } from "./backends/chatcrystal.js";
import { captureHook, projectForHookPayload } from "./hook.js";
import { acknowledgeContext, contextStatus, issueContextReceipt, normalizeClientAgent, startVerification, verificationStatus, } from "./receipts.js";
function string(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function evidenceKind(value) {
    const allowed = new Set([
        "decision",
        "constraint",
        "progress",
        "verification",
        "unresolved",
        "handoff",
    ]);
    if (!allowed.has(value))
        throw new Error(`Invalid evidence kind: ${String(value)}`);
    return value;
}
function evidenceState(value) {
    const allowed = new Set(["candidate", "verified", "stale"]);
    if (!allowed.has(value))
        throw new Error(`Invalid evidence state: ${String(value)}`);
    return value;
}
function agent(value) {
    const allowed = new Set(["codex", "claude", "cursor", "antigravity", "archive", "unknown"]);
    return allowed.has(value) ? value : "unknown";
}
function memorixQueueState(store, projectId) {
    const pending = store.pendingOutbox("memorix").filter((row) => row.project_id === projectId).length;
    return { queued: pending > 0, pending };
}
export class CampService {
    store;
    requestFastSync;
    constructor(store, requestFastSync = () => undefined) {
        this.store = store;
        this.requestFastSync = requestFastSync;
    }
    project(value) {
        return resolveProject(this.store, string(value, process.cwd()));
    }
    async makeFresh(projectId, verificationRunId) {
        const project = this.store.getProject(projectId);
        if (!project)
            throw new Error(`Unknown project: ${projectId}`);
        const freshness = this.store.sourceFreshness(projectId);
        const stale = !freshness.length ||
            freshness.some((item) => item.enabled &&
                // Refresh before the hard 120-second receipt gate so context
                // assembly and a prompt acknowledgment have a useful safety margin.
                (item.status !== "ok" || item.lastSuccessfulScanAt === null || (item.lagSeconds ?? Infinity) > 90));
        const run = verificationRunId ? this.store.refreshVerificationRun(verificationRunId) : null;
        if (stale || (run && run.status !== "ready")) {
            this.requestFastSync(project.id);
            // If the daemon is already scanning this project, return a truthful
            // FAIL receipt promptly instead of recursively duplicating a large
            // import. The next retry will observe the completed successful scan.
            if (!this.store.projectSyncInProgress(project.id)) {
                await syncProjectSources(this.store, project);
            }
        }
    }
    async call(method, params, client) {
        switch (method) {
            case "ping":
                return { ok: true, pid: process.pid };
            case "setup": {
                const project = setupProject(this.store, string(params.path, "."));
                let handoff = this.store.latestHandoff(project.id);
                if (!handoff) {
                    const paths = changedPaths(project.rootPath);
                    handoff = this.store.createHandoff(project, {
                        goal: `Continue development in ${basename(project.rootPath)}`,
                        completed: [],
                        changedPaths: paths,
                        validations: [],
                        unresolved: paths.length
                            ? ["The worktree is dirty; historical status and validation must be rechecked before edits"]
                            : [],
                        nextSteps: ["Inspect current project files and retrieve task-specific CAMP context"],
                        sourceSessions: this.store.listOrdinarySessionIds(project.id).slice(-5),
                    });
                    queueMemorix(this.store, project, handoff);
                }
                prepareMemorixMigration(this.store, project);
                const memorix = memorixQueueState(this.store, project.id);
                // Canonical CAMP state is durable at this point. Mirroring and history
                // indexing continue through the daemon outbox instead of blocking init.
                this.requestFastSync(project.id);
                return { project, handoff, memorix, importRequested: params.import !== false };
            }
            case "sync": {
                const project = this.project(params.project);
                return syncProject(this.store, project);
            }
            case "status": {
                const project = this.project(params.project);
                // Staleness is refreshed by the daemon's serialized sync/context
                // paths. Status is deliberately a read-only snapshot so it remains
                // available while a long initial import owns the writer FIFO.
                return this.store.projectStatus(project.id);
            }
            case "doctor":
                return runDoctor(this.store);
            case "review": {
                const project = this.project(params.project);
                if (typeof params.assign === "string") {
                    if (!this.store.resolveQuarantine(params.assign, project.id)) {
                        throw new Error(`Open quarantine item not found: ${params.assign}`);
                    }
                }
                return this.store.listQuarantine(project.id);
            }
            case "search": {
                const project = this.project(params.project);
                const source = new Set(["raw", "curated", "all"]).has(string(params.source))
                    ? string(params.source)
                    : "all";
                return hybridSearch(this.store, project.id, string(params.query), source, Math.max(1, Math.min(50, number(params.limit, 20))));
            }
            case "conversation": {
                const project = this.project(params.project);
                const session = this.store.getSession(string(params.conversationId), project.id);
                if (!session)
                    throw new Error(`Conversation not found in this project: ${String(params.conversationId)}`);
                return session;
            }
            case "recordMemory": {
                const project = this.project(params.project);
                const kind = evidenceKind(params.kind);
                if (kind === "handoff")
                    throw new Error("Use createHandoff for handoff records");
                const record = this.store.putEvidence({
                    projectId: project.id,
                    kind,
                    state: evidenceState(params.state ?? "candidate"),
                    title: string(params.title).trim(),
                    content: string(params.content).trim(),
                    confidence: Math.max(0, Math.min(1, number(params.confidence, 0.8))),
                    sourceAgent: normalizeClientAgent(client.name),
                    sourceSessionId: string(params.sourceSessionId) || null,
                    sourceUri: string(params.sourceSessionId)
                        ? `camp://${normalizeClientAgent(client.name)}/session/${string(params.sourceSessionId)}`
                        : null,
                    relevantFiles: strings(params.relevantFiles),
                    commit: null,
                    worktreeFingerprint: null,
                });
                queueMemorix(this.store, project, record);
                this.requestFastSync(project.id);
                return { record, memorix: memorixQueueState(this.store, project.id) };
            }
            case "createHandoff": {
                const project = this.project(params.project);
                const handoff = {
                    goal: string(params.goal, `Continue development in ${basename(project.rootPath)}`),
                    completed: strings(params.completed),
                    changedPaths: params.changedPaths ? strings(params.changedPaths) : changedPaths(project.rootPath),
                    validations: strings(params.validations),
                    unresolved: strings(params.unresolved),
                    nextSteps: strings(params.nextSteps),
                    sourceSessions: params.sourceSessions
                        ? strings(params.sourceSessions)
                        : this.store.listOrdinarySessionIds(project.id).slice(-5),
                };
                const record = this.store.createHandoff(project, handoff);
                queueMemorix(this.store, project, record);
                this.requestFastSync(project.id);
                return { record, memorix: memorixQueueState(this.store, project.id) };
            }
            case "remove": {
                const project = this.project(params.project);
                const purge = params.purge === true;
                if (purge) {
                    const memorix = archiveMemorixProjectRecords(this.store, project);
                    if (memorix.unavailable || memorix.errors.length) {
                        throw new Error(`Memorix purge gate failed: ${memorix.errors.join("; ")}`);
                    }
                    await purgeChatCrystalProject(this.store, project);
                }
                this.store.unregisterProject(project.id, purge);
                if (purge) {
                    const archive = join(this.store.paths.archiveDir, project.id);
                    if (existsSync(archive))
                        rmSync(archive, { recursive: true, force: false });
                }
                return { project, purge, remainingProjects: this.store.listProjects().length };
            }
            case "reindex":
                this.store.rebuildLexicalIndexes();
                return { rebuilt: true };
            case "capture": {
                const source = agent(params.agent);
                const event = string(params.event);
                const payload = params.payload && typeof params.payload === "object"
                    ? params.payload
                    : {};
                const output = captureHook(this.store, source, event, payload, (projectId) => this.requestFastSync(projectId));
                const receiptEvent = (source === "antigravity" && event === "PreInvocation") ||
                    ((source === "codex" || source === "claude") &&
                        (event === "SessionStart" || event === "UserPromptSubmit"));
                const project = receiptEvent ? projectForHookPayload(this.store, payload) : null;
                if (!project)
                    return output;
                const task = string(payload.prompt ??
                    payload.userPrompt ??
                    payload.user_prompt ??
                    payload.input ??
                    "Start this agent session with the current CAMP project handoff");
                try {
                    const issued = await issueContextReceipt({
                        store: this.store,
                        project,
                        task,
                        client: { ...client, name: `${source}-hook`, deliveryMode: "hook" },
                    });
                    if (source === "antigravity") {
                        return { ...output, injectSteps: [{ ephemeralMessage: issued.text }] };
                    }
                    return {
                        ...output,
                        continue: true,
                        hookSpecificOutput: {
                            hookEventName: event,
                            additionalContext: issued.text,
                        },
                    };
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const unavailable = `CAMP context receipt could not be issued (${message}). ` +
                        "Do not claim CAMP context is verified; call camp_context_for_task explicitly.";
                    if (source === "antigravity") {
                        return { ...output, injectSteps: [{ ephemeralMessage: unavailable }] };
                    }
                    return {
                        ...output,
                        continue: true,
                        hookSpecificOutput: { hookEventName: event, additionalContext: unavailable },
                    };
                }
            }
            case "context": {
                const project = this.project(params.project);
                const task = string(params.task).trim();
                if (!task)
                    throw new Error("task is required");
                const verificationRunId = string(params.verificationRunId) || null;
                await this.makeFresh(project.id, verificationRunId);
                return issueContextReceipt({
                    store: this.store,
                    project,
                    task,
                    client,
                    verificationRunId,
                });
            }
            case "ackContext":
                return acknowledgeContext({
                    store: this.store,
                    receiptId: string(params.receiptId),
                    challenge: string(params.challenge),
                    evidenceIds: strings(params.evidenceIds),
                    recalledFact: string(params.recalledFact),
                    client,
                });
            case "contextStatus":
                return contextStatus(this.store, string(params.receiptId));
            case "startVerification": {
                const project = this.project(params.project);
                await this.makeFresh(project.id);
                return startVerification({
                    store: this.store,
                    project,
                    client,
                    targetAgents: strings(params.targetAgents).map(agent),
                    ttlSeconds: number(params.ttlSeconds, 900),
                });
            }
            case "verificationStatus":
                return verificationStatus(this.store, string(params.runId));
            case "cancelVerification":
                return this.store.cancelVerificationRun(string(params.runId));
            case "listProjects":
                return this.store.listProjects();
            default:
                throw new Error(`Unknown CAMP daemon RPC method: ${method}`);
        }
    }
}
//# sourceMappingURL=service.js.map