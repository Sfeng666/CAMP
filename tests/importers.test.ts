import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { importCodex } from "../src/importers/codex.js";
import { importClaude } from "../src/importers/claude.js";
import { importAntigravity } from "../src/importers/antigravity.js";
import { captureHook } from "../src/hook.js";

function jsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("streaming native history adapters", () => {
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

  it("streams Codex JSONL with source offsets and restart checkpoints", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sessions = join(env.root, "codex-sessions");
    const path = join(sessions, "session.jsonl");
    jsonl(path, [
      { type: "session_meta", payload: { id: "codex-native", cwd: project.rootPath } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { type: "message", id: "u1", role: "user", content: "Implement shared memory" },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "function_call", call_id: "c1", name: "test", arguments: "{}" },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: { type: "function_call_output", call_id: "c1", output: "tests passed" },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:03Z",
        payload: { type: "message", id: "a1", role: "assistant", content: "Implemented it" },
      },
    ]);

    const first = await importCodex(store, project, sessions);
    const second = await importCodex(store, project, sessions);
    expect(first.imported).toBe(1);
    expect(second.skipped).toBe(1);
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.messages).toHaveLength(4);
    expect(session?.messages[0]?.metadata?.sourceLine).toBe(2);
    expect(session?.messages.some((message) => message.kind === "tool-result")).toBe(true);
  });

  it("imports a nested codex_summary archive with original source provenance", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const archive = join(
      root,
      "codex_summary",
      "chat_history",
      "project_chat_history.jsonl",
    );
    jsonl(archive, [
      {
        session_id: "archived-session",
        source_file: "/sanitized/codex/session.jsonl",
        timestamp: "2026-01-01T00:00:00Z",
        role: "user",
        text: "Use humane outreach with a low-pressure ask",
      },
      {
        session_id: "archived-session",
        source_file: "/sanitized/codex/session.jsonl",
        timestamp: "2026-01-01T00:00:01Z",
        role: "assistant",
        text: "The constraint is recorded",
      },
    ]);

    const result = await importCodex(store, project, join(env.root, "empty-sessions"));
    expect(result.imported).toBe(1);
    const hit = store.search(project.id, "humane outreach", "raw")[0];
    expect(hit?.source).toBe("archive");
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.messages[0]?.metadata?.sourceFile).toBe(
      "/sanitized/codex/session.jsonl",
    );
  });

  it("quarantines a parent-workspace Claude session until it is explicitly assigned", async () => {
    const parent = join(env.root, "workspace-parent");
    const root = join(parent, "project");
    mkdirSync(root, { recursive: true });
    const project = setupProject(store, root);
    const sessions = join(env.root, "claude-projects");
    const path = join(sessions, "session.jsonl");
    jsonl(path, [
      {
        type: "user",
        uuid: "u1",
        sessionId: "claude-native",
        cwd: parent,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "Work on one sibling" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "claude-native",
        cwd: parent,
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "Need explicit project assignment" },
      },
    ]);
    const first = await importClaude(store, project, sessions);
    expect(first.quarantined).toBe(1);
    expect(first.imported).toBe(0);
    const item = store.listQuarantine(project.id)[0];
    expect(store.resolveQuarantine(String(item?.id), project.id)).toBe(true);
    const second = await importClaude(store, project, sessions);
    expect(second.imported).toBe(1);
  });

  it("captures Antigravity hook transcripts and quarantines unknown local schemas", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    captureHook(store, "antigravity", "PreInvocation", {
      cwd: project.rootPath,
      conversationId: "ag-native",
      prompt: "Implement the bridge",
    });
    captureHook(store, "antigravity", "PostInvocation", {
      cwd: project.rootPath,
      conversationId: "ag-native",
      response: "Bridge implemented",
    });

    const nativeRoot = join(env.root, "antigravity");
    mkdirSync(nativeRoot);
    const dbPath = join(nativeRoot, "trajectory.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE trajectories (payload BLOB)");
    db.prepare("INSERT INTO trajectories(payload) VALUES (?)").run(
      Buffer.from(`protobuf:${project.rootPath}`),
    );
    db.close();

    const result = await importAntigravity(store, project, nativeRoot);
    expect(result.imported).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(
      store.search(project.id, "Bridge implemented", "raw").some((hit) => hit.content === "Bridge implemented"),
    ).toBe(true);
  });

  it("imports an exact-project Antigravity CLI transcript without guessing its schema", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const cliRoot = join(env.root, "antigravity-cli", "brain");
    const transcript = join(
      cliRoot,
      "conversation-1",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    jsonl(transcript, [
      {
        conversationId: "conversation-1",
        workspacePaths: [project.rootPath],
        role: "user",
        message: "Continue from terminal memory",
      },
      {
        conversationId: "conversation-1",
        workspacePaths: [project.rootPath],
        role: "assistant",
        message: "Antigravity CLI history is now available",
      },
    ]);
    process.env.ANTIGRAVITY_DATA_DIR = cliRoot;

    const result = await importAntigravity(store, project, join(env.root, "no-native-db"));
    expect(result.imported).toBe(1);
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.surface).toBe("cli");
    expect(session?.sourceVersion).toBe("antigravity-transcript@1");
  });
});
