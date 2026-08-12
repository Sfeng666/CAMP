import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { changedPaths, worktreeFingerprint } from "../src/git.js";

describe("content-sensitive worktree receipts", () => {
  let env: IsolatedCamp;
  let root: string;

  beforeEach(() => {
    env = isolatedCamp();
    root = join(env.root, "project");
    mkdirSync(root);
    spawnSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "tracked.txt"), "clean\n");
    spawnSync("git", ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "add", "."]);
    spawnSync("git", ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "commit", "-qm", "fixture"]);
  });

  afterEach(() => env.cleanup());

  it("changes when an already-dirty tracked file is rewritten with the same length", () => {
    writeFileSync(join(root, "tracked.txt"), "first\n");
    const first = worktreeFingerprint(root);
    writeFileSync(join(root, "tracked.txt"), "other\n");
    expect(worktreeFingerprint(root)).not.toBe(first);
  });

  it("changes for staged content and same-path untracked content", () => {
    writeFileSync(join(root, "tracked.txt"), "stage-one\n");
    spawnSync("git", ["-C", root, "add", "tracked.txt"]);
    const staged = worktreeFingerprint(root);
    writeFileSync(join(root, "tracked.txt"), "stage-two\n");
    expect(worktreeFingerprint(root)).not.toBe(staged);

    writeFileSync(join(root, "untracked.txt"), "alpha\n");
    const untracked = worktreeFingerprint(root);
    writeFileSync(join(root, "untracked.txt"), "bravo\n");
    expect(worktreeFingerprint(root)).not.toBe(untracked);
  });

  it("ignores only untracked SpecStory transcript churn during acknowledgment", () => {
    const history = join(root, ".specstory", "history");
    mkdirSync(history, { recursive: true });
    const transcript = join(history, "session.md");
    writeFileSync(transcript, "first live transcript snapshot\n");
    const before = worktreeFingerprint(root);
    writeFileSync(transcript, "second live transcript snapshot\n");
    expect(worktreeFingerprint(root)).toBe(before);
    expect(changedPaths(root)).not.toContain(".specstory/");

    spawnSync("git", ["-C", root, "add", ".specstory/history/session.md"]);
    expect(changedPaths(root)).toContain(".specstory/history/session.md");
    const staged = worktreeFingerprint(root);
    writeFileSync(transcript, "tracked transcript changed\n");
    expect(worktreeFingerprint(root)).not.toBe(staged);
  });

  it("ignores only unstaged SpecStory statistics churn and binds it once staged", () => {
    const directory = join(root, ".specstory");
    mkdirSync(directory, { recursive: true });
    const statistics = join(directory, "statistics.json");
    writeFileSync(statistics, '{"events":1}\n');
    spawnSync("git", ["-C", root, "add", ".specstory/statistics.json"]);
    spawnSync("git", [
      "-C",
      root,
      "-c",
      "user.name=CAMP Test",
      "-c",
      "user.email=camp@example.invalid",
      "commit",
      "-qm",
      "track SpecStory statistics fixture",
    ]);
    const clean = worktreeFingerprint(root);
    writeFileSync(statistics, '{"events":2}\n');
    expect(worktreeFingerprint(root)).toBe(clean);
    expect(changedPaths(root)).not.toContain(".specstory/statistics.json");

    spawnSync("git", ["-C", root, "add", ".specstory/statistics.json"]);
    expect(changedPaths(root)).toContain(".specstory/statistics.json");
    expect(worktreeFingerprint(root)).not.toBe(clean);
  });

  it("creates a content-sensitive fingerprint for a non-Git workspace", () => {
    const workspace = join(env.root, "plain-workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "notes.txt"), "alpha\n");
    const first = worktreeFingerprint(workspace);
    expect(first).toMatch(/^workspace:[a-f0-9]{64}$/);
    writeFileSync(join(workspace, "notes.txt"), "bravo\n");
    expect(worktreeFingerprint(workspace)).not.toBe(first);
  });
});
