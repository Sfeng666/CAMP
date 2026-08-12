#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspectProject } from "./git.js";
import { portableProjectId, writePortableManifest } from "./registry.js";
import { detectClients, installIntegrations, installUserService, removeIntegrations, removeUserService, } from "./integrations.js";
import { acknowledgeEmbeddingReindex, ensureLocalModels } from "./models.js";
import { getCampPaths } from "./paths.js";
import { exportLegacyPima } from "./legacy.js";
import { runMcpServer } from "./mcp.js";
import { runDaemon } from "./daemon.js";
import { callDaemon, defaultRpcIdentity, ensureDaemon, rpcCall, waitForDaemonExit, } from "./rpc.js";
import { bootstrapDatabase } from "./bootstrap.js";
import { CAMP_VERSION } from "./version.js";
const VERSION = CAMP_VERSION;
const MINIMUM_NODE = [22, 18, 0];
function requireSupportedNode() {
    const current = process.versions.node.split(".").map((part) => Number(part));
    for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
        const actual = current[index] ?? 0;
        const required = MINIMUM_NODE[index] ?? 0;
        if (actual > required)
            return;
        if (actual < required) {
            throw new Error(`CAMP requires Node.js 22.18.0 or newer; current runtime is ${process.versions.node}`);
        }
    }
}
requireSupportedNode();
function json(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function line(value = "") {
    process.stdout.write(`${value}\n`);
}
function sourceSummary(summary) {
    return `${summary.source}: scanned=${summary.scanned} imported=${summary.imported} replaced=${summary.replaced} skipped=${summary.skipped} quarantined=${summary.quarantined} errors=${summary.errors.length}`;
}
function pathOwner() {
    return { paths: getCampPaths() };
}
async function bootstrapAfterDaemonStop() {
    let last = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            return await bootstrapDatabase();
        }
        catch (error) {
            last = error;
            if (!/(?:still owns the pre-v\d+ database|schema migration is already owned|acquire the schema migration lock)/i.test(error instanceof Error ? error.message : String(error)))
                throw error;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
    }
    throw last;
}
async function confirmPurge(projectPath) {
    if (!process.stdin.isTTY)
        return false;
    const reader = createInterface({ input, output });
    try {
        const answer = await reader.question(`Type the exact project path to permanently purge CAMP data:\n${projectPath}\n> `);
        return resolve(answer.trim()) === resolve(projectPath);
    }
    finally {
        reader.close();
    }
}
function parseAgent(value) {
    const allowed = new Set(["codex", "claude", "cursor", "antigravity", "archive", "unknown"]);
    if (!allowed.has(value))
        throw new Error(`Unsupported agent: ${value}`);
    return value;
}
const program = new Command();
program.name("camp").description("CAMP — Cross-Agent Memory for Projects").version(VERSION);
program
    .command("init")
    .description("Register a project, configure installed agents, and import matching history")
    .argument("[path]", "Repository or workspace path", ".")
    .option("--dry-run", "Inspect without changing CAMP, IDE, or project files")
    .option("--portable", "Write a path-free .camp/project.toml manifest")
    .option("--no-import", "Register without importing history")
    .action(async (path, options) => {
    const inspected = inspectProject(path);
    if (options.dryRun) {
        json({
            action: "init-dry-run",
            project: inspected,
            clients: detectClients(),
            trackedProjectChanges: options.portable ? [".camp/project.toml"] : [],
            dataRoot: getCampPaths().home,
        });
        return;
    }
    const owner = pathOwner();
    const integrations = installIntegrations(owner);
    const service = installUserService(owner, true);
    await ensureDaemon(service.active ? 30_000 : 5_000);
    const setup = await rpcCall("setup", { path, import: options.import });
    const project = setup.project;
    line(`Registered ${project.id} (${project.kind})`);
    line(`Project: ${project.rootPath}`);
    if (options.portable)
        line(`Portable manifest: ${writePortableManifest(project)}`);
    for (const item of integrations)
        line(`${item.client}: ${item.status} — ${item.detail}`);
    const liveMachineBootstrap = !process.env.CAMP_USER_HOME || resolve(process.env.CAMP_USER_HOME) === resolve(process.env.HOME ?? "");
    const models = ensureLocalModels(liveMachineBootstrap, liveMachineBootstrap);
    line(!models.available || models.missing.length
        ? `models: degraded — ${models.actions.join("; ")}`
        : "models: ready");
    line(`daemon: ${service.active ? "active" : "session"} — ${service.detail}`);
    if (options.import && process.env.CAMP_SETUP_FOREGROUND === "1") {
        const result = await rpcCall("sync", { project: project.id }, defaultRpcIdentity(), 10 * 60_000);
        result.imports.forEach((summary) => line(sourceSummary(summary)));
        result.errors.forEach((error) => line(`degraded: ${error}`));
    }
    else if (options.import) {
        line("history: indexing continues resumably in the CAMP daemon");
    }
    line(`Run: camp status ${JSON.stringify(project.rootPath)}`);
});
program
    .command("sync")
    .description("Import new project history and flush backend outboxes")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--once", "Perform one synchronization pass")
    .option("--json", "Emit JSON")
    .action(async (path, options) => {
    const result = await callDaemon("sync", { project: path }, undefined, 10 * 60_000);
    if (options.json)
        json(result);
    else {
        result.imports.forEach((summary) => line(sourceSummary(summary)));
        if (result.chatcrystal)
            line(`chatcrystal: ${JSON.stringify(result.chatcrystal)}`);
        line(`memorix: ${JSON.stringify(result.memorix)}`);
        result.errors.forEach((error) => line(`degraded: ${error}`));
    }
});
program
    .command("status")
    .description("Show project archive, freshness, and memory status")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--json", "Emit JSON")
    .action(async (path, options) => {
    const status = await callDaemon("status", { project: path });
    if (options.json)
        json(status);
    else {
        line(`${status.project.rootPath} (${status.project.id})`);
        line(`kind=${status.project.kind} sessions=${status.sessions} messages=${status.messages} evidence=${status.evidence}`);
        line(`quarantined=${status.quarantined} last_import=${status.lastImportedAt ?? "never"}`);
        line(`sources=${JSON.stringify(status.bySource)}`);
        status.freshness.forEach((item) => line(`freshness:${item.source} status=${item.status} lag=${item.lagSeconds ?? "never"}s last_success=${item.lastSuccessfulScanAt ?? "never"}`));
        const degraded = status.health.filter((item) => item.status === "degraded");
        if (degraded.length)
            line(`degraded=${JSON.stringify(degraded)}`);
    }
});
program
    .command("doctor")
    .description("Diagnose CAMP, backend, model, and agent integration health")
    .option("--json", "Emit JSON")
    .option("--repair", "Repair CAMP-owned integrations and pull missing local models")
    .action(async (options) => {
    const repairs = [];
    if (options.repair) {
        repairs.push(...installIntegrations(pathOwner()));
        repairs.push(ensureLocalModels(true, true));
        repairs.push(installUserService(pathOwner(), true));
    }
    const checks = await callDaemon("doctor");
    if (options.json)
        json({ checks, repairs });
    else
        checks.forEach((check) => line(`${check.status.padEnd(8)} ${check.name}: ${check.detail}`));
    if (checks.some((check) => check.status === "error"))
        process.exitCode = 1;
});
program
    .command("review")
    .description("List or resolve quarantined ambiguous history")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--assign <quarantine-id>", "Assign a quarantined source to this project")
    .option("--json", "Emit JSON")
    .action(async (path, options) => {
    const items = await callDaemon("review", {
        project: path,
        assign: options.assign,
    });
    if (options.json)
        json(items);
    else if (!items.length)
        line("No open quarantine items.");
    else
        items.forEach((item) => line(`${item.id} ${item.source}: ${item.reason}\n  ${item.source_path}`));
});
program
    .command("search")
    .description("Search raw conversations and curated memory")
    .argument("<query>", "Search query")
    .option("--project <path-or-id>", "Registered project path or UUID", ".")
    .option("--source <source>", "raw, curated, or all", "all")
    .option("--limit <number>", "Maximum results", "20")
    .option("--json", "Emit JSON")
    .action(async (query, options) => {
    const hits = await callDaemon("search", {
        project: options.project,
        query,
        source: options.source,
        limit: Number(options.limit),
    });
    if (options.json)
        json(hits);
    else
        hits.forEach((hit) => line(`[${hit.layer}/${hit.source}] ${hit.title}\n${hit.content}\n${hit.uri}\n`));
});
program
    .command("handoff")
    .description("Create a structured current project handoff")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--task <text>", "Current goal")
    .option("--completed <item...>", "Completed items")
    .option("--validation <item...>", "Validation evidence")
    .option("--unresolved <item...>", "Unresolved issues")
    .option("--next <item...>", "Recommended next steps")
    .option("--json", "Emit JSON")
    .action(async (path, options) => {
    const result = await callDaemon("createHandoff", {
        project: path,
        goal: options.task,
        completed: options.completed,
        validations: options.validation,
        unresolved: options.unresolved,
        nextSteps: options.next,
    });
    if (options.json)
        json(result);
    else
        line(`Created handoff ${result.record.id}`);
});
program
    .command("context-status")
    .description("Inspect a context receipt and its acknowledgment without exposing the challenge")
    .requiredOption("--receipt <id>", "Context receipt ID")
    .option("--json", "Emit JSON")
    .action(async (options) => {
    const result = await callDaemon("contextStatus", { receiptId: options.receipt });
    if (options.json)
        json(result);
    else
        line(JSON.stringify(result, null, 2));
});
const verify = program.command("verify").description("Inspect or cancel an expiring cross-agent canary");
verify
    .command("status")
    .argument("<run-id>", "Verification run ID")
    .option("--json", "Emit JSON")
    .action(async (runId, options) => {
    const result = await callDaemon("verificationStatus", { runId });
    if (options.json)
        json(result);
    else
        line(JSON.stringify(result, null, 2));
});
verify
    .command("cancel")
    .argument("<run-id>", "Verification run ID")
    .action(async (runId) => json(await callDaemon("cancelVerification", { runId })));
program
    .command("remove")
    .description("Unregister a project; keep data unless --purge is explicitly confirmed")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--purge", "Permanently delete this project's CAMP data")
    .option("--confirm <project-id>", "Confirm purge with the exact registered project UUID")
    .action(async (path, options) => {
    const status = await callDaemon("status", { project: path });
    const project = status.project;
    if (options.purge && options.confirm !== project.id && !(await confirmPurge(project.rootPath))) {
        throw new Error("Purge was not confirmed; no data was deleted");
    }
    const result = await callDaemon("remove", {
        project: project.id,
        purge: Boolean(options.purge),
    });
    const portable = resolve(project.rootPath, ".camp", "project.toml");
    if (portableProjectId(project.rootPath) === project.id && existsSync(portable))
        unlinkSync(portable);
    if (!result.remainingProjects) {
        await rpcCall("shutdown").catch(() => undefined);
        removeIntegrations(pathOwner()).forEach((item) => line(`${item.client}: ${item.detail}`));
        line(removeUserService(pathOwner()));
    }
    line(options.purge ? "Project data purged" : "Project unregistered; archive retained");
});
program
    .command("upgrade")
    .description("Inspect or apply backend compatibility and schema upgrades")
    .option("--check", "Show pinned versions and upgrade policy")
    .option("--apply", "Apply the compatibility-tested CAMP release upgrade")
    .action(async (options) => {
    if (!options.apply) {
        json({
            camp: VERSION,
            pins: { chatcrystal: "0.5.8", memorix: "1.3.1", "better-sqlite3": "12.11.1" },
            applied: false,
            detail: "All runtime dependencies are locked by the published npm-shrinkwrap.json.",
        });
        return;
    }
    // Stop the service manager first so it cannot race the old owner by
    // immediately respawning it. Migrations and replacement binaries are
    // touched only after the exact writer process releases its lock.
    removeUserService(pathOwner());
    await rpcCall("shutdown", {}, defaultRpcIdentity(), 5_000).catch(() => undefined);
    await waitForDaemonExit();
    const migration = await bootstrapAfterDaemonStop();
    const service = installUserService(pathOwner(), true);
    await ensureDaemon(service.active ? 30_000 : 5_000);
    json({ camp: VERSION, applied: true, migration, service });
});
program
    .command("legacy-export")
    .description("Create a verified, read-only export of legacy PIMA data; never deletes it")
    .requiredOption("--from-pima", "Confirm that the source is the local legacy PIMA installation")
    .option("--output <directory>", "Private destination directory; defaults to CAMP backups")
    .action(async (options) => {
    if (!options.fromPima)
        throw new Error("legacy-export requires --from-pima");
    json(await exportLegacyPima(options.output));
});
program
    .command("reindex")
    .description("Rebuild CAMP search indexes after an explicitly confirmed embedding-model change")
    .requiredOption("--embedding-digest <digest>", "Exact digest recorded in camp doctor --json")
    .action(async (options) => {
    await callDaemon("reindex");
    json({ rebuilt: true, modelManifest: acknowledgeEmbeddingReindex(options.embeddingDigest) });
});
program.command("mcp").description("Run the CAMP composite MCP server over stdio").action(async () => runMcpServer());
program
    .command("daemon")
    .description("Run continuous synchronization and the authenticated local RPC service")
    .option("--interval <milliseconds>", "Polling interval", "60000")
    .action(async (options) => runDaemon(Math.max(5_000, Number(options.interval))));
program
    .command("capture")
    .description("Capture a host hook event without opening the CAMP database")
    .requiredOption("--agent <agent>", "codex, claude, cursor, or antigravity")
    .requiredOption("--event <event>", "Native hook event name")
    .action(async (options) => {
    const raw = readFileSync(0, "utf8").trim();
    let payload = {};
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                payload = parsed;
        }
        catch {
            process.stdout.write(JSON.stringify({ continue: true }));
            return;
        }
    }
    const source = parseAgent(options.agent);
    const identity = defaultRpcIdentity("hook");
    identity.name = `${source}-hook`;
    identity.instanceId = String(payload.session_id ?? payload.sessionId ?? identity.instanceId);
    const result = await callDaemon("capture", { agent: source, event: options.event, payload }, identity);
    process.stdout.write(JSON.stringify(result));
});
program.parseAsync(process.argv).catch((error) => {
    process.stderr.write(`camp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map