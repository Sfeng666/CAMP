import Database from "better-sqlite3";
import { mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { importCursor } from "../src/importers/cursor.js";
import { sha256 } from "../src/utils.js";

function cursorFixture(root: string, projectRoot: string, schema = 3): string {
  const workspace = join(root, "workspaceStorage", "fixture");
  const global = join(root, "globalStorage");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(global, { recursive: true });
  writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: `file://${projectRoot}` }));

  const workspaceDb = new Database(join(workspace, "state.vscdb"));
  workspaceDb.exec("CREATE TABLE ItemTable ([key] TEXT PRIMARY KEY, value TEXT)");
  workspaceDb
    .prepare("INSERT INTO ItemTable([key], value) VALUES (?, ?)")
    .run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "composer-1", name: "Outreach changes" }] }),
    );
  workspaceDb.close();

  const globalPath = join(global, "state.vscdb");
  const globalDb = new Database(globalPath);
  globalDb.exec("CREATE TABLE cursorDiskKV ([key] TEXT PRIMARY KEY, value TEXT)");
  const insert = globalDb.prepare("INSERT INTO cursorDiskKV([key], value) VALUES (?, ?)");
  insert.run(
    "bubbleId:composer-1:user",
    JSON.stringify({ _v: schema, bubbleId: "user", type: 1, text: "Implement project-scoped memory", createdAt: 1_700_000_000_000 }),
  );
  insert.run(
    "bubbleId:composer-1:assistant",
    JSON.stringify({
      _v: schema,
      bubbleId: "assistant",
      type: 2,
      text: "Added safe read-only Cursor import",
      createdAt: 1_700_000_001_000,
      attachments: [
        { id: "image-1", mimeType: "image/png", base64: "fixture-binary-content" },
      ],
    }),
  );
  globalDb.close();
  return globalPath;
}

describe("Cursor transcript bridge", () => {
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

  it("queries only matching composer keys in read-only mode and is idempotent", async () => {
    const projectRoot = join(env.root, "project");
    mkdirSync(projectRoot);
    const project = setupProject(store, projectRoot);
    const cursorRoot = join(env.root, "cursor-user");
    const globalPath = cursorFixture(cursorRoot, projectRoot);
    const before = sha256(readFileSync(globalPath));
    const beforeMtime = statSync(globalPath).mtimeMs;

    const first = await importCursor(store, project, cursorRoot);
    const second = await importCursor(store, project, cursorRoot);

    expect(first.imported).toBe(1);
    expect(second.skipped).toBe(1);
    expect(store.search(project.id, "read-only Cursor import", "raw")).toHaveLength(1);
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.attachments?.[0]).toMatchObject({
      hash: sha256("fixture-binary-content"),
      mediaType: "image/png",
      sourceUri: "image-1",
    });
    expect(sha256(readFileSync(globalPath))).toBe(before);
    expect(statSync(globalPath).mtimeMs).toBe(beforeMtime);
  });

  it("quarantines an unknown Cursor schema instead of guessing", async () => {
    const projectRoot = join(env.root, "project");
    mkdirSync(projectRoot);
    const project = setupProject(store, projectRoot);
    const cursorRoot = join(env.root, "cursor-user");
    cursorFixture(cursorRoot, projectRoot, 99);

    const result = await importCursor(store, project, cursorRoot);
    expect(result.imported).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(store.listQuarantine(project.id)[0]?.reason).toMatch(/Unknown Cursor bubble schema/);
  });

  it("imports modern global composer headers and quarantines sibling-project sessions", async () => {
    const projectRoot = join(env.root, "project");
    const siblingRoot = join(env.root, "sibling");
    mkdirSync(projectRoot);
    mkdirSync(siblingRoot);
    const project = setupProject(store, projectRoot);
    const cursorRoot = join(env.root, "cursor-user");
    const global = join(cursorRoot, "globalStorage");
    mkdirSync(global, { recursive: true });
    const globalPath = join(global, "state.vscdb");
    const db = new Database(globalPath);
    db.exec(`
      CREATE TABLE cursorDiskKV ([key] TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        workspaceId TEXT,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        value TEXT
      );
    `);
    const insertHeader = db.prepare(
      "INSERT INTO composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt, value) VALUES (?, ?, ?, ?, ?)",
    );
    const header = (composerId: string, paths: string[]) =>
      JSON.stringify({
        type: "head",
        composerId,
        name: `Modern ${composerId}`,
        trackedGitRepos: paths.map((repoPath) => ({ repoPath })),
        workspaceIdentifier: { uri: { fsPath: env.root } },
      });
    insertHeader.run(
      "modern-exact",
      "parent",
      1,
      2,
      header("modern-exact", [project.rootPath]),
    );
    insertHeader.run(
      "modern-ambiguous",
      "parent",
      3,
      4,
      header("modern-ambiguous", [project.rootPath, siblingRoot]),
    );
    const insertBubble = db.prepare("INSERT INTO cursorDiskKV([key], value) VALUES (?, ?)");
    // UUID-like key order is intentionally the opposite of timestamp order.
    insertBubble.run(
      "bubbleId:modern-exact:a-assistant",
      JSON.stringify({
        _v: 3,
        bubbleId: "a-assistant",
        type: 2,
        text: "Modern Cursor response",
        createdAt: "2026-01-01T00:00:02Z",
      }),
    );
    insertBubble.run(
      "bubbleId:modern-exact:z-user",
      JSON.stringify({
        _v: 3,
        bubbleId: "z-user",
        type: 1,
        text: "Modern Cursor prompt",
        createdAt: "2026-01-01T00:00:01Z",
      }),
    );
    insertBubble.run(
      "bubbleId:modern-ambiguous:user",
      JSON.stringify({
        _v: 3,
        bubbleId: "user",
        type: 1,
        text: "Work across both projects",
        createdAt: "2026-01-01T00:00:03Z",
      }),
    );
    db.close();

    const result = await importCursor(store, project, cursorRoot);
    expect(result.imported).toBe(1);
    expect(result.quarantined).toBe(1);
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.sourceVersion).toBe("cursor-vscdb@2");
    expect(session?.messages.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(store.listQuarantine(project.id)[0]?.reason).toMatch(/spans sibling Git repositories/);
  });

  it("does not scale RSS with a sparse multi-gigabyte Cursor database fixture", async () => {
    const projectRoot = join(env.root, "project");
    mkdirSync(projectRoot);
    const project = setupProject(store, projectRoot);
    const cursorRoot = join(env.root, "cursor-user");
    const globalPath = cursorFixture(cursorRoot, projectRoot);
    truncateSync(globalPath, 6 * 1024 * 1024 * 1024);
    expect(statSync(globalPath).size).toBe(6 * 1024 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    const result = await importCursor(store, project, cursorRoot);
    const delta = Math.max(0, process.memoryUsage().rss - before);
    expect(result.imported).toBe(1);
    expect(delta).toBeLessThan(750 * 1024 * 1024);
  });

  it("imports Cursor Agent CLI JSONL only from the exact registered project directory", async () => {
    const projectRoot = join(env.root, "project with spaces");
    mkdirSync(projectRoot);
    const project = setupProject(store, projectRoot);
    const projects = join(env.root, "cursor-projects");
    const encoded = project.rootPath.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const transcript = join(projects, encoded, "agent-transcripts", "chat-1", "chat-1.jsonl");
    mkdirSync(join(projects, encoded, "agent-transcripts", "chat-1"), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", message: "Remember the terminal implementation" }),
        JSON.stringify({ role: "assistant", message: "Cursor Agent CLI transcript imported" }),
      ].join("\n"),
    );
    process.env.CURSOR_PROJECTS_DIR = projects;

    const first = await importCursor(store, project, join(env.root, "no-cursor-ide"));
    const second = await importCursor(store, project, join(env.root, "no-cursor-ide"));
    expect(first.imported).toBe(1);
    expect(second.skipped).toBe(1);
    const session = store.getSession(store.listSessionIds(project.id)[0] ?? "", project.id);
    expect(session?.surface).toBe("cli");
    expect(session?.sourceVersion).toBe("cursor-agent-transcript@1");
  });
});
