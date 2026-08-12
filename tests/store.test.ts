import { mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { SCHEMA_VERSION, type CanonicalSession } from "../src/types.js";
import { stableId, truncateByApproxTokens } from "../src/utils.js";
import {
  archiveMemorixProjectRecords,
  finalizeMemorixMigration,
  flushMemorix,
  prepareMemorixMigration,
  queueMemorix,
} from "../src/backends/memorix.js";
import { changedPaths } from "../src/git.js";

describe("project registry and stores", () => {
  let env: IsolatedCamp;
  let store: CampStore;

  beforeEach(() => {
    env = isolatedCamp();
    store = new CampStore();
  });

  afterEach(() => {
    store.close();
    env.cleanup();
  });

  it("retains a non-Git project UUID after a folder move and Git initialization", () => {
    const firstPath = join(env.root, "first-name");
    const movedPath = join(env.root, "renamed-workspace");
    mkdirSync(firstPath);
    writeFileSync(join(firstPath, "notes.txt"), "hello\n");

    const first = setupProject(store, firstPath);
    const inode = statSync(firstPath).ino;
    renameSync(firstPath, movedPath);
    const moved = setupProject(store, movedPath);

    expect(moved.id).toBe(first.id);
    expect(moved.rootPath).toBe(realpathSync(movedPath));
    expect(statSync(movedPath).ino).toBe(inode);
    expect(moved.migrationState).toBe("fallback");

    const init = spawnSync("git", ["init", "-q", movedPath], { encoding: "utf8" });
    expect(init.status).toBe(0);
    const gitProject = setupProject(store, movedPath);
    expect(gitProject.id).toBe(first.id);
    expect(gitProject.kind).toBe("git");
    expect(gitProject.migrationState).toBe("pending-memorix");
  });

  it("marks a daemon-interrupted source scan degraded before accepting new work", () => {
    const root = join(env.root, "interrupted-sync");
    mkdirSync(root);
    const project = setupProject(store, root);
    store.beginSourceSync(project.id, "cursor");
    expect(store.projectSyncInProgress(project.id)).toBe(true);
    expect(store.recoverInterruptedSyncs()).toBe(1);
    expect(store.projectSyncInProgress(project.id)).toBe(false);
    expect(store.sourceFreshness(project.id)[0]).toMatchObject({
      source: "cursor",
      status: "degraded",
      error: { phase: "recovery" },
    });
  });

  it("reconciles a Git worktree and a non-origin remote with the same project", () => {
    const root = join(env.root, "git-project");
    const worktree = join(env.root, "git-worktree");
    mkdirSync(root);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    writeFileSync(join(root, "README.md"), "fixture\n");
    expect(
      spawnSync(
        "git",
        ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "add", "README.md"],
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "commit", "-qm", "fixture"],
      ).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["-C", root, "remote", "add", "upstream", "git@github.com:Example/Camp-Fixture.git"]).status,
    ).toBe(0);
    const primary = setupProject(store, root);
    expect(primary.remotes).toEqual(["github.com/Example/Camp-Fixture"]);
    expect(spawnSync("git", ["-C", root, "worktree", "add", "-qb", "fixture-worktree", worktree]).status).toBe(0);
    const secondary = setupProject(store, worktree);
    expect(secondary.id).toBe(primary.id);
    expect(secondary.activePaths).toEqual(expect.arrayContaining([primary.rootPath, secondary.rootPath]));
  });

  it("deletes only exactly matched CAMP Memorix records through an idempotent purge", async () => {
    const root = join(env.root, "memorix-purge-project");
    mkdirSync(root);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const project = setupProject(store, root);
    const record = store.putEvidence({
      projectId: project.id,
      kind: "decision",
      state: "verified",
      title: "Exact CAMP purge fixture",
      content: "The fixture uses exact title and narrative matching before archival.",
      confidence: 1,
      sourceAgent: "camp",
      sourceSessionId: null,
      sourceUri: null,
      relevantFiles: [],
      commit: null,
      worktreeFingerprint: null,
    });
    queueMemorix(store, project, record);
    expect(await flushMemorix(store, project)).toMatchObject({ completed: 1, failed: 0 });

    expect(archiveMemorixProjectRecords(store, project)).toMatchObject({
      deleted: 1,
      alreadyDeleted: 0,
      unavailable: false,
      errors: [],
    });
    expect(archiveMemorixProjectRecords(store, project)).toMatchObject({
      deleted: 0,
      alreadyDeleted: 1,
      unavailable: false,
      errors: [],
    });
  });

  it("writes the pinned Memorix observation contract without leaking quarantined evidence", async () => {
    const root = join(env.root, "memorix-contract-project");
    mkdirSync(root);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const project = setupProject(store, root);
    const record = store.putEvidence({
      projectId: project.id,
      kind: "decision",
      state: "verified",
      title: "Compatible curated observation",
      content: "CAMP preserves the Memorix 1.3.1 observation contract.",
      confidence: 1,
      sourceAgent: "camp",
      sourceSessionId: null,
      sourceUri: "camp://contract-test",
      relevantFiles: ["README.md"],
      commit: null,
      worktreeFingerprint: null,
    });
    queueMemorix(store, project, record);
    expect(await flushMemorix(store, project)).toMatchObject({
      completed: 1,
      failed: 0,
      unavailable: false,
    });

    const cli = join(process.cwd(), "node_modules", "memorix", "dist", "cli", "index.js");
    const recent = spawnSync(
      process.execPath,
      [cli, "memory", "recent", "--limit", "10", "--json", "--cwd", root],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MEMORIX_DATA_DIR: join(store.paths.backendDir, "memorix"),
          MEMORIX_AUTO_UPDATE: "off",
        },
        timeout: 30_000,
      },
    );
    expect(recent.status, recent.stderr).toBe(0);
    expect(recent.stdout).toContain(record.title);

    const quarantined = store.putEvidence({
      projectId: project.id,
      kind: "verification",
      state: "quarantined",
      title: "Isolated canary",
      content: "This payload must not enter ordinary Memorix recall.",
      confidence: 1,
      sourceAgent: "cursor",
      sourceSessionId: "canary-session",
      sourceUri: "camp://verification/quarantined",
      relevantFiles: [],
      commit: null,
      worktreeFingerprint: null,
    });
    const pendingBefore = store.pendingOutbox("memorix").length;
    queueMemorix(store, project, quarantined);
    expect(store.pendingOutbox("memorix")).toHaveLength(pendingBefore);
  });

  it("preserves the first changed path from porcelain status exactly", () => {
    const root = join(env.root, "git-status-project");
    mkdirSync(root);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    writeFileSync(join(root, "README.md"), "untracked\n");
    writeFileSync(join(root, "file with spaces.txt"), "untracked\n");
    expect(changedPaths(root)).toEqual(["README.md", "file with spaces.txt"]);
  });

  it("stores canonical sessions idempotently and keeps search project-scoped", () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sourcePath = join(root, "source.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const session: CanonicalSession = {
      schemaVersion: SCHEMA_VERSION,
      source: "codex",
      nativeId: "session-1",
      projectId: project.id,
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      sourcePath,
      sourceFingerprint: "fixture-v1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      messages: [
        {
          id: "m1",
          sequence: 0,
          role: "user",
          kind: "message",
          content: "Make outreach humane and greet with the recipient first name",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "I added a warm multi-paragraph low-pressure referral ask.",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    };

    expect(store.storeSession(session).status).toBe("imported");
    expect(store.storeSession(session).status).toBe("skipped");
    expect(store.projectStatus(project.id).sessions).toBe(1);
    expect(store.projectStatus(project.id).messages).toBe(2);
    expect(store.search(project.id, "humane recipient first name", "raw")).toHaveLength(1);

    const otherRoot = join(env.root, "other");
    mkdirSync(otherRoot);
    const other = setupProject(store, otherRoot);
    expect(store.search(other.id, "humane recipient first name", "all")).toEqual([]);
  });

  it("appends a growing transcript without duplicating prior messages", async () => {
    const root = join(env.root, "growing-workspace");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sourcePath = join(root, "growing.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const base: CanonicalSession = {
      schemaVersion: SCHEMA_VERSION,
      source: "codex",
      surface: "cli",
      nativeId: "growing-session",
      projectId: project.id,
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      sourcePath,
      sourceFingerprint: "extent-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      messages: [
        {
          id: "one",
          sequence: 0,
          role: "user",
          kind: "message",
          content: "First stable message OLDPREFIXONLY",
          timestamp: "2026-01-01T00:00:00.000Z",
          metadata: { sourceLine: 1 },
        },
        {
          id: "two",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "Second stable message",
          timestamp: "2026-01-01T00:01:00.000Z",
          metadata: { sourceLine: 2 },
        },
      ],
    };
    expect(store.storeSession(base).status).toBe("imported");
    const grown: CanonicalSession = {
      ...base,
      sourceFingerprint: "extent-2",
      endedAt: "2026-01-01T00:02:00.000Z",
      messages: [
        ...base.messages,
        {
          id: "three",
          sequence: 2,
          role: "assistant",
          kind: "message",
          content: "Third appended message",
          timestamp: "2026-01-01T00:02:00.000Z",
          metadata: { sourceLine: 3 },
        },
      ],
    };
    expect(await store.storeSessionAsync(grown)).toMatchObject({ status: "replaced" });
    expect(store.getSession(stableId(project.id, "codex", base.nativeId), project.id)?.messages).toHaveLength(3);
    expect(await store.storeSessionAsync(grown)).toMatchObject({ status: "skipped" });
    expect(store.projectStatus(project.id).messages).toBe(3);

    const rewritten: CanonicalSession = {
      ...grown,
      sourceFingerprint: "extent-3",
      messages: grown.messages.map((item, index) =>
        index === 0 ? { ...item, content: "First safely rewritten message NEWPREFIXONLY" } : item,
      ),
    };
    expect(await store.storeSessionAsync(rewritten)).toMatchObject({ status: "replaced" });
    expect(store.projectStatus(project.id).messages).toBe(3);
    expect(store.search(project.id, "NEWPREFIXONLY", "raw")).toHaveLength(1);
    expect(store.search(project.id, "OLDPREFIXONLY", "raw")).toHaveLength(0);
  });

  it("rejects secrets from curated memory, redacts raw recall, and bounds handoffs", () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const project = setupProject(store, root);
    expect(() =>
      store.putEvidence({
        projectId: project.id,
        kind: "decision",
        state: "candidate",
        title: "Deployment key",
        content: "api_key=supersecretvalue12345",
        confidence: 0.5,
        sourceAgent: "camp",
        sourceSessionId: null,
        sourceUri: null,
        relevantFiles: [],
        commit: null,
        worktreeFingerprint: null,
      }),
    ).toThrow(/credential or secret/i);

    expect(() =>
      store.putEvidence({
        projectId: project.id,
        kind: "progress",
        state: "candidate",
        title: "Generated outreach",
        content: "Hi Taylor, I hope you are well. Would you refer me to the hiring manager?",
        confidence: 0.5,
        sourceAgent: "camp",
        sourceSessionId: null,
        sourceUri: null,
        relevantFiles: [],
        commit: null,
        worktreeFingerprint: null,
      }),
    ).toThrow(/user-facing outreach/i);

    expect(() =>
      store.putEvidence({
        projectId: project.id,
        kind: "constraint",
        state: "candidate",
        title: "Outreach process policy",
        content: "Use the recipient first name and keep any referral ask low-pressure.",
        confidence: 0.9,
        sourceAgent: "camp",
        sourceSessionId: null,
        sourceUri: null,
        relevantFiles: [],
        commit: null,
        worktreeFingerprint: null,
      }),
    ).not.toThrow();

    const handoff = store.createHandoff(project, {
      goal: "Continue the current implementation",
      completed: ["Created the registry"],
      changedPaths: [],
      validations: ["tests passed"],
      unresolved: [],
      nextSteps: ["Run the pilot"],
      sourceSessions: [],
    });
    expect(store.latestHandoff(project.id)?.id).toBe(handoff.id);
    expect(truncateByApproxTokens("x".repeat(10_000), 800).length).toBeLessThanOrEqual(3_200);
  });

  it("persists restartable checkpoints and deduplicates quarantine records", () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const project = setupProject(store, root);
    store.setCheckpoint(project.id, "codex", "fixture", "offset:42");
    expect(store.checkpoint(project.id, "codex", "fixture")).toBe("offset:42");
    const input = {
      projectId: project.id,
      source: "cursor" as const,
      sourcePath: "/tmp/cursor.db",
      nativeId: "ambiguous",
      reason: "parent workspace",
    };
    expect(store.addQuarantine(input)).toBe(store.addQuarantine(input));
    expect(store.projectStatus(project.id).quarantined).toBe(1);
    const quarantineId = store.addQuarantine(input);
    expect(store.resolveQuarantine(quarantineId, project.id)).toBe(true);
    expect(store.isSourceAssigned("cursor", input.sourcePath, input.nativeId, project.id)).toBe(true);
  });

  it("marks file-dependent evidence stale when its source file changes", () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const path = join(root, "policy.ts");
    writeFileSync(path, "export const policy = 'first';\n");
    const project = setupProject(store, root);
    const record = store.putEvidence({
      projectId: project.id,
      kind: "verification",
      state: "verified",
      title: "Policy was verified",
      content: "The current implementation enforces the policy.",
      confidence: 1,
      sourceAgent: "camp",
      sourceSessionId: null,
      sourceUri: null,
      relevantFiles: ["policy.ts"],
      commit: null,
      worktreeFingerprint: null,
    });
    expect(record.fileFingerprints["policy.ts"]).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(path, "export const policy = 'second-and-changed';\n");
    expect(store.refreshStaleness(project.id)).toBe(1);
    expect(store.getEvidence(record.id)?.state).toBe("stale");
  });

  it("keeps equivalent historical handoffs when a newer candidate also becomes stale", () => {
    // Reproduce the pre-v3 on-disk index before opening a new store. The
    // constructor must migrate it without touching the project records.
    store.db.exec(`
      DROP INDEX IF EXISTS evidence_dedupe_idx;
      CREATE UNIQUE INDEX evidence_dedupe_idx
        ON evidence(project_id, kind, content_hash, state);
      INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
    `);
    store.close();
    store = new CampStore();
    const dedupeIndex = store.db
      .prepare("PRAGMA index_list(evidence)")
      .all() as Array<{ name: string; unique: number }>;
    expect(dedupeIndex.find((index) => index.name === "evidence_dedupe_idx")?.unique).toBe(0);

    const root = join(env.root, "equivalent-handoffs");
    mkdirSync(root);
    const path = join(root, "policy.ts");
    writeFileSync(path, "export const policy = 'first';\n");
    const project = setupProject(store, root);
    const input = {
      projectId: project.id,
      kind: "handoff" as const,
      state: "candidate" as const,
      title: "Current handoff: retain duplicate history safely",
      content: "Goal: retain equivalent handoffs across stale-state transitions.",
      confidence: 0.8,
      sourceAgent: "camp" as const,
      sourceSessionId: null,
      sourceUri: null,
      relevantFiles: ["policy.ts"],
      commit: null,
      worktreeFingerprint: null,
    };
    const first = store.putEvidence(input);
    writeFileSync(path, "export const policy = 'second';\n");
    expect(store.refreshStaleness(project.id)).toBe(1);
    expect(store.getEvidence(first.id)?.state).toBe("stale");

    const second = store.putEvidence(input);
    expect(second.id).not.toBe(first.id);
    writeFileSync(path, "export const policy = 'third';\n");
    expect(store.refreshStaleness(project.id)).toBe(1);
    expect(store.listEvidence(project.id).map((record) => record.state)).toEqual(["stale", "stale"]);
  });

  it("verifies a one-time fallback-to-Memorix migration by count and content hash", () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    let project = setupProject(store, root);
    const fallback = store.putEvidence({
      projectId: project.id,
      kind: "decision",
      state: "candidate",
      title: "Use a local archive",
      content: "Keep raw project conversations local and project-scoped.",
      confidence: 0.9,
      sourceAgent: "camp",
      sourceSessionId: null,
      sourceUri: null,
      relevantFiles: [],
      commit: null,
      worktreeFingerprint: null,
    });
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    project = setupProject(store, root);
    expect(project.migrationState).toBe("pending-memorix");
    expect(prepareMemorixMigration(store, project).expected).toBe(1);
    for (const row of store.pendingOutbox("memorix")) store.completeOutbox(String(row.id));
    expect(finalizeMemorixMigration(store, project)).toBe(true);
    expect(store.getProject(project.id)?.migrationState).toBe("migrated");
    expect(store.getEvidence(fallback.id)?.contentHash).toBe(fallback.contentHash);
    expect(setupProject(store, root).migrationState).toBe("migrated");
  });
});
