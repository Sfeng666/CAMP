import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";

const SOURCE = resolve("src", "cli.ts");

describe("one-command project bootstrap", () => {
  let env: IsolatedCamp;

  beforeEach(() => {
    env = isolatedCamp();
  });

  afterEach(() => env.cleanup());

  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", SOURCE, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CAMP_HOME: env.data,
        CAMP_CONFIG_HOME: env.config,
        CAMP_USER_HOME: env.user,
        CODEX_SESSIONS_DIR: join(env.root, "no-codex"),
        CLAUDE_PROJECTS_DIR: join(env.root, "no-claude"),
        CURSOR_DATA_DIR: join(env.root, "no-cursor"),
        ANTIGRAVITY_DATA_DIR: join(env.root, "no-antigravity"),
      },
      timeout: 30_000,
    });
  }

  it("registers any non-Git workspace idempotently without editing it", () => {
    const root = join(env.root, "plain-workspace");
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "unchanged\n");
    const before = readdirSync(root).sort();

    const first = run(["init", root, "--no-import"]);
    const second = run(["init", root, "--no-import"]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(readdirSync(root).sort()).toEqual(before);

    const status = run(["status", root, "--json"]);
    expect(status.status, status.stderr).toBe(0);
    const parsed = JSON.parse(status.stdout) as {
      project: { id: string; kind: string };
      evidence: number;
    };
    expect(parsed.project.kind).toBe("workspace");
    expect(parsed.evidence).toBe(1);
  });

  it("keeps dry-run side-effect free and writes only a path-free portable manifest when requested", () => {
    const root = join(env.root, "portable-workspace");
    mkdirSync(root);
    const dry = run(["init", root, "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(readdirSync(root)).toEqual([]);

    const initialized = run(["init", root, "--portable", "--no-import"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    const manifestPath = join(root, ".camp", "project.toml");
    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).not.toContain(root);
    expect(manifest).toContain("project_id");
  });

  it("unregisters reversibly, restores owned integrations, and reuses retained identity", () => {
    const root = join(env.root, "removable-workspace");
    mkdirSync(root);
    mkdirSync(join(env.user, ".codex"), { recursive: true });
    mkdirSync(join(env.user, ".cursor"), { recursive: true });
    writeFileSync(join(env.user, ".codex", "config.toml"), "model = \"fixture\"\n");
    writeFileSync(
      join(env.user, ".cursor", "mcp.json"),
      `${JSON.stringify({ mcpServers: { existing: { command: "keep" } } })}\n`,
    );

    expect(run(["init", root, "--no-import"]).status).toBe(0);
    const before = JSON.parse(run(["status", root, "--json"]).stdout) as {
      project: { id: string };
      evidence: number;
    };
    const removed = run(["remove", root]);
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("archive retained");
    expect(readFileSync(join(env.user, ".codex", "config.toml"), "utf8")).toBe(
      "model = \"fixture\"\n",
    );
    const cursor = JSON.parse(readFileSync(join(env.user, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursor.mcpServers.existing).toBeDefined();
    expect(cursor.mcpServers.camp).toBeUndefined();
    expect(existsSync(join(env.user, "Library", "LaunchAgents", "io.campmemory.daemon.plist"))).toBe(false);

    expect(run(["init", root, "--no-import"]).status).toBe(0);
    const after = JSON.parse(run(["status", root, "--json"]).stdout) as {
      project: { id: string };
      evidence: number;
    };
    expect(after.project.id).toBe(before.project.id);
    expect(after.evidence).toBe(before.evidence);
  });
});
