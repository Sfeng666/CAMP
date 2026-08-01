#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspectProject, changedPaths } from "./git.js";
import { CampStore } from "./store.js";
import { resolveProject, setupProject, portableProjectId, writePortableManifest } from "./registry.js";
import { detectClients, installIntegrations, installUserService, removeIntegrations, removeUserService } from "./integrations.js";
import { syncProject } from "./sync.js";
import { runDoctor } from "./doctor.js";
import { acknowledgeEmbeddingReindex, ensureLocalModels } from "./models.js";
import { getCampPaths } from "./paths.js";
import { exportLegacyPima } from "./legacy.js";
import { finalizeMemorixMigration, archiveMemorixProjectRecords, queueMemorix, flushMemorix, prepareMemorixMigration, } from "./backends/memorix.js";
import { runMcpServer } from "./mcp.js";
import { runDaemon } from "./daemon.js";
import { captureHook } from "./hook.js";
import { hybridSearch } from "./semantic.js";
import { purgeChatCrystalProject } from "./backends/chatcrystal.js";
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
    const allowed = new Set([
        "codex",
        "claude",
        "cursor",
        "antigravity",
        "archive",
        "unknown",
    ]);
    if (!allowed.has(value))
        throw new Error(`Unsupported agent: ${value}`);
    return value;
}
function startBackgroundSync(projectId, cwd) {
    const script = process.argv[1];
    if (!script || !existsSync(script))
        return false;
    const args = script.endsWith(".ts")
        ? ["--import", "tsx", script, "sync", projectId, "--once"]
        : [script, "sync", projectId, "--once"];
    const child = spawn(process.execPath, args, {
        cwd,
        detached: true,
        env: process.env,
        stdio: "ignore",
    });
    child.unref();
    return true;
}
const program = new Command();
program
    .name("camp")
    .description("CAMP — Cross-Agent Memory for Projects")
    .version(VERSION);
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
    const store = new CampStore();
    try {
        const project = setupProject(store, path);
        line(`Registered ${project.id} (${project.kind})`);
        line(`Project: ${project.rootPath}`);
        if (options.portable)
            line(`Portable manifest: ${writePortableManifest(project)}`);
        const integrations = installIntegrations(store);
        for (const item of integrations)
            line(`${item.client}: ${item.status} — ${item.detail}`);
        if (!store.latestHandoff(project.id)) {
            const paths = changedPaths(project.rootPath);
            const record = store.createHandoff(project, {
                goal: `Continue development in ${basename(project.rootPath)}`,
                completed: [],
                changedPaths: paths,
                validations: [],
                unresolved: paths.length
                    ? ["The worktree is dirty; historical status and validation must be rechecked before edits"]
                    : [],
                nextSteps: ["Inspect current project files and retrieve task-specific CAMP context"],
                sourceSessions: store.listSessionIds(project.id).slice(-5),
            });
            queueMemorix(store, project, record);
        }
        prepareMemorixMigration(store, project);
        flushMemorix(store, project);
        finalizeMemorixMigration(store, project);
        const liveMachineBootstrap = !process.env.CAMP_USER_HOME || resolve(process.env.CAMP_USER_HOME) === resolve(process.env.HOME ?? "");
        const models = ensureLocalModels(liveMachineBootstrap, liveMachineBootstrap);
        if (!models.available || models.missing.length) {
            line(`models: degraded — ${models.actions.join("; ")}`);
        }
        else {
            line("models: ready");
        }
        const service = installUserService(store, true);
        line(`daemon: ${service.active ? "active" : "written"} — ${service.detail}`);
        if (options.import) {
            if (process.env.CAMP_SETUP_FOREGROUND === "1") {
                const result = await syncProject(store, project, (summary) => line(sourceSummary(summary)));
                if (result.chatcrystal) {
                    line(`chatcrystal: imported=${result.chatcrystal.imported} replaced=${result.chatcrystal.replaced} skipped=${result.chatcrystal.skipped} errors=${result.chatcrystal.errors}`);
                }
                for (const error of result.errors)
                    line(`degraded: ${error}`);
            }
            else if (service.active) {
                line(`history: indexing continues resumably in the ${service.kind} CAMP daemon`);
            }
            else if (startBackgroundSync(project.id, project.rootPath)) {
                line("history: indexing started in a detached local sync process");
            }
            else {
                line("history: indexing pending — run camp sync --once");
            }
        }
        line(`Run: camp status ${JSON.stringify(project.rootPath)}`);
    }
    finally {
        store.close();
    }
});
program
    .command("sync")
    .description("Import new project history and flush backend outboxes")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--once", "Perform one synchronization pass")
    .option("--json", "Emit JSON")
    .action(async (path, options) => {
    const store = new CampStore();
    try {
        const project = resolveProject(store, path);
        const result = await syncProject(store, project, options.json ? undefined : (summary) => line(sourceSummary(summary)));
        if (options.json)
            json(result);
        else {
            if (result.chatcrystal)
                line(`chatcrystal: ${JSON.stringify(result.chatcrystal)}`);
            line(`memorix: ${JSON.stringify(result.memorix)}`);
            result.errors.forEach((value) => line(`degraded: ${value}`));
        }
    }
    finally {
        store.close();
    }
});
program
    .command("status")
    .description("Show project archive and memory status")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--json", "Emit JSON")
    .action((path, options) => {
    const store = new CampStore();
    try {
        const project = resolveProject(store, path);
        const status = store.projectStatus(project.id);
        if (options.json)
            json(status);
        else {
            line(`${project.rootPath} (${project.id})`);
            line(`kind=${project.kind} sessions=${status.sessions} messages=${status.messages} evidence=${status.evidence}`);
            line(`quarantined=${status.quarantined} last_import=${status.lastImportedAt ?? "never"}`);
            line(`sources=${JSON.stringify(status.bySource)}`);
            const degraded = status.health.filter((item) => item.status === "degraded");
            if (degraded.length)
                line(`degraded=${JSON.stringify(degraded)}`);
        }
    }
    finally {
        store.close();
    }
});
program
    .command("doctor")
    .description("Diagnose CAMP, backend, model, and agent integration health")
    .option("--json", "Emit JSON")
    .option("--repair", "Repair CAMP-owned integrations and pull missing local models")
    .action(async (options) => {
    const store = new CampStore();
    try {
        const repairs = [];
        if (options.repair) {
            repairs.push(...installIntegrations(store));
            repairs.push(ensureLocalModels(true, true));
            repairs.push(installUserService(store, true));
        }
        const checks = await runDoctor(store);
        if (options.json)
            json({ checks, repairs });
        else {
            checks.forEach((check) => line(`${check.status.padEnd(8)} ${check.name}: ${check.detail}`));
        }
        if (checks.some((check) => check.status === "error"))
            process.exitCode = 1;
    }
    finally {
        store.close();
    }
});
program
    .command("review")
    .description("List or resolve quarantined ambiguous history")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--assign <quarantine-id>", "Assign a quarantined source to this project")
    .option("--json", "Emit JSON")
    .action((path, options) => {
    const store = new CampStore();
    try {
        const project = resolveProject(store, path);
        if (options.assign) {
            const resolved = store.resolveQuarantine(options.assign, project.id);
            if (!resolved)
                throw new Error(`Open quarantine item not found: ${options.assign}`);
        }
        const items = store.listQuarantine(project.id);
        if (options.json)
            json(items);
        else if (!items.length)
            line("No open quarantine items.");
        else
            items.forEach((item) => line(`${item.id} ${item.source}: ${item.reason}\n  ${item.source_path}`));
    }
    finally {
        store.close();
    }
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
    const store = new CampStore();
    try {
        const project = resolveProject(store, options.project);
        const source = new Set(["raw", "curated", "all"]).has(options.source)
            ? options.source
            : "all";
        const hits = await hybridSearch(store, project.id, query, source, Math.max(1, Math.min(50, Number(options.limit))));
        if (options.json)
            json(hits);
        else
            hits.forEach((hit) => line(`[${hit.layer}/${hit.source}] ${hit.title}\n${hit.content}\n${hit.uri}\n`));
    }
    finally {
        store.close();
    }
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
    .action((path, options) => {
    const store = new CampStore();
    try {
        const project = resolveProject(store, path);
        const handoff = {
            goal: options.task ?? `Continue development in ${basename(project.rootPath)}`,
            completed: options.completed ?? [],
            changedPaths: changedPaths(project.rootPath),
            validations: options.validation ?? [],
            unresolved: options.unresolved ?? [],
            nextSteps: options.next ?? [],
            sourceSessions: store.listSessionIds(project.id).slice(-5),
        };
        const record = store.createHandoff(project, handoff);
        queueMemorix(store, project, record);
        const backend = flushMemorix(store, project);
        if (options.json)
            json({ record, memorix: backend });
        else
            line(`Created handoff ${record.id}; Memorix completed=${backend.completed} failed=${backend.failed}`);
    }
    finally {
        store.close();
    }
});
program
    .command("remove")
    .description("Unregister a project; keep data unless --purge is explicitly confirmed")
    .argument("[path]", "Registered project path or UUID", ".")
    .option("--purge", "Permanently delete this project's CAMP data")
    .option("--confirm <project-id>", "Confirm purge with the exact registered project UUID")
    .action(async (path, options) => {
    const store = new CampStore();
    try {
        const project = resolveProject(store, path);
        if (options.purge &&
            options.confirm !== project.id &&
            !(await confirmPurge(project.rootPath))) {
            throw new Error("Purge was not confirmed; no data was deleted");
        }
        if (options.purge) {
            const memorix = archiveMemorixProjectRecords(store, project);
            if (memorix.unavailable || memorix.errors.length) {
                throw new Error(`Memorix purge gate failed: ${memorix.errors.join("; ")}`);
            }
            line(`memorix: deleted=${memorix.deleted} already_deleted=${memorix.alreadyDeleted}`);
            await purgeChatCrystalProject(store, project);
        }
        store.unregisterProject(project.id, Boolean(options.purge));
        if (options.purge) {
            const archive = join(store.paths.archiveDir, project.id);
            if (existsSync(archive))
                rmSync(archive, { recursive: true, force: false });
        }
        const portable = resolve(project.rootPath, ".camp", "project.toml");
        if (portableProjectId(project.rootPath) === project.id && existsSync(portable))
            unlinkSync(portable);
        if (!store.listProjects().length) {
            removeIntegrations(store).forEach((result) => line(`${result.client}: ${result.detail}`));
            line(removeUserService(store));
        }
        line(options.purge ? "Project data purged" : "Project unregistered; archive retained");
    }
    finally {
        store.close();
    }
});
program
    .command("upgrade")
    .description("Inspect or apply backend compatibility upgrades")
    .option("--check", "Show pinned versions and upgrade policy")
    .option("--apply", "Apply a compatibility-tested CAMP release upgrade")
    .action((options) => {
    json({
        camp: VERSION,
        pins: { chatcrystal: "0.5.8", memorix: "1.3.1", "better-sqlite3": "12.11.1" },
        applied: false,
        detail: options.apply
            ? "Backend pins change only in a compatibility-tested CAMP release; no unreviewed upgrade was applied."
            : "All backend versions are locked by package-lock.json.",
    });
});
program
    .command("legacy-export")
    .description("Create a verified, read-only export of legacy PIMA data; never deletes it")
    .requiredOption("--from-pima", "Confirm that the source is the local legacy PIMA installation")
    .option("--output <directory>", "Private destination directory; defaults to CAMP backups")
    .action(async (options) => {
    if (!options.fromPima)
        throw new Error("legacy-export requires --from-pima");
    const exported = await exportLegacyPima(options.output);
    json({
        source: exported.source,
        output: exported.output,
        database: exported.database,
        counts: exported.counts,
        files: exported.files.length,
        manifest: exported.manifest,
    });
});
program
    .command("reindex")
    .description("Rebuild CAMP search indexes after an explicitly confirmed embedding-model change")
    .requiredOption("--embedding-digest <digest>", "Exact digest recorded in camp doctor --json")
    .action((options) => {
    const store = new CampStore();
    try {
        store.rebuildLexicalIndexes();
        const manifest = acknowledgeEmbeddingReindex(options.embeddingDigest);
        json({ rebuilt: true, modelManifest: manifest });
    }
    finally {
        store.close();
    }
});
program
    .command("mcp")
    .description("Run the CAMP composite MCP server over stdio")
    .action(async () => runMcpServer());
program
    .command("daemon")
    .description("Run continuous synchronization for registered projects")
    .option("--interval <milliseconds>", "Polling interval", "60000")
    .action(async (options) => runDaemon(Math.max(5_000, Number(options.interval))));
program
    .command("capture")
    .description("Capture a host hook event without blocking the host")
    .requiredOption("--agent <agent>", "codex, claude, cursor, or antigravity")
    .requiredOption("--event <event>", "Native hook event name")
    .action((options) => {
    const raw = readFileSync(0, "utf8").trim();
    let payload = {};
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                payload = parsed;
            }
        }
        catch {
            process.stdout.write(JSON.stringify({ continue: true }));
            return;
        }
    }
    const store = new CampStore();
    try {
        process.stdout.write(JSON.stringify(captureHook(store, parseAgent(options.agent), options.event, payload)));
    }
    finally {
        store.close();
    }
});
program.parseAsync(process.argv).catch((error) => {
    process.stderr.write(`camp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map