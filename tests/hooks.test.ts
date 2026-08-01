import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { captureHook } from "../src/hook.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { createAutomaticHandoff } from "../src/sync.js";

describe("bounded automatic recall and handoff", () => {
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

  it("injects a bounded handoff and task evidence only on the first prompt", () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    store.createHandoff(project, {
      goal: "Finish project memory synchronization",
      completed: ["Registered the workspace"],
      changedPaths: [],
      validations: [],
      unresolved: ["Run the live switch test"],
      nextSteps: ["Inspect current files"],
      sourceSessions: [],
    });
    store.putEvidence({
      projectId: project.id,
      kind: "decision",
      state: "candidate",
      title: "Cursor safety gate",
      content: "Cursor databases are opened read-only and queried by composer key.",
      confidence: 0.9,
      sourceAgent: "camp",
      sourceSessionId: null,
      sourceUri: null,
      relevantFiles: [],
      commit: null,
      worktreeFingerprint: null,
    });

    const start = captureHook(store, "codex", "SessionStart", {
      cwd: root,
      session_id: "hook-session",
    });
    const startContext = (start.hookSpecificOutput as { additionalContext?: string })?.additionalContext;
    expect(startContext).toContain("Finish project memory synchronization");
    expect(startContext?.length).toBeLessThanOrEqual(3_200);

    const first = captureHook(store, "codex", "UserPromptSubmit", {
      cwd: root,
      session_id: "hook-session",
      prompt: "How is the Cursor database queried safely?",
    });
    const firstContext = (first.hookSpecificOutput as { additionalContext?: string })?.additionalContext;
    expect(firstContext).toContain("Cursor safety gate");
    expect(firstContext?.length).toBeLessThanOrEqual(6_400);

    const second = captureHook(store, "codex", "UserPromptSubmit", {
      cwd: root,
      session_id: "hook-session",
      prompt: "How is the Cursor database queried safely?",
    });
    expect(second.hookSpecificOutput).toBeUndefined();
    const spool = join(env.data, "spool", "hooks.jsonl");
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("creates one candidate handoff for the latest substantive archived session", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "{}\n");
    store.storeSession({
      schemaVersion: SCHEMA_VERSION,
      source: "codex",
      nativeId: "session-1",
      projectId: project.id,
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      sourcePath,
      sourceFingerprint: "fixture",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      messages: [
        {
          id: "u1",
          sequence: 0,
          role: "user",
          kind: "message",
          content: "Implement project-scoped automatic handoffs",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "Implemented the handoff pipeline.",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    });
    const first = await createAutomaticHandoff(store, project);
    expect(first?.kind).toBe("handoff");
    expect(first?.state).toBe("candidate");
    expect(await createAutomaticHandoff(store, project)).toBeNull();
  });

  it("prefers a project-authored status handoff and labels its validation historical", async () => {
    const root = join(env.root, "project");
    const summary = join(root, "codex_summary");
    mkdirSync(summary, { recursive: true });
    writeFileSync(
      join(summary, "PROJECT_STATUS.md"),
      [
        "# Project status",
        "",
        "## 1. Current goal",
        "",
        "Build seamless cross-IDE recall for this project.",
        "",
        "## 2. What is implemented",
        "",
        "- Raw history import is working.",
        "",
        "## 3. Validation evidence",
        "",
        "- Historical tests passed.",
        "",
        "## 4. Problems not solved",
        "",
        "1. Live switching still needs verification.",
        "",
        "## 5. Recommended next-agent sequence",
        "",
        "1. Inspect the current worktree.",
      ].join("\n"),
    );
    const project = setupProject(store, root);
    store.createHandoff(project, {
      goal: "Generic setup handoff",
      completed: [],
      changedPaths: [],
      validations: [],
      unresolved: [],
      nextSteps: [],
      sourceSessions: [],
    });
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "{}\n");
    store.storeSession({
      schemaVersion: SCHEMA_VERSION,
      source: "codex",
      nativeId: "session-with-scaffold",
      projectId: project.id,
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      sourcePath,
      sourceFingerprint: "fixture",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      messages: [
        {
          id: "u1",
          sequence: 0,
          role: "user",
          kind: "message",
          content: "<recommended_plugins>host scaffolding</recommended_plugins>",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "Ready.",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    await createAutomaticHandoff(store, project);
    const handoff = store.latestHandoffPayload(project.id);
    expect(handoff?.goal).toBe("Build seamless cross-IDE recall for this project.");
    expect(handoff?.validations[0]).toContain("historical codex_summary/PROJECT_STATUS.md");
    expect(handoff?.unresolved).toContain("Live switching still needs verification.");
    expect(handoff?.unresolved.at(-1)).toMatch(/snapshot is historical/);
  });
});
