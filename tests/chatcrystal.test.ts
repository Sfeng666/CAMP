import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { purgeChatCrystalProject, syncChatCrystal } from "../src/backends/chatcrystal.js";

describe("ChatCrystal normalized ingest extension", () => {
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

  it("indexes only CAMP-normalized project sessions and reruns idempotently", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "{}\n");
    store.storeSession({
      schemaVersion: SCHEMA_VERSION,
      source: "antigravity",
      sourceVersion: "fixture@1",
      nativeId: "ag-1",
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
          content: "Remember this project decision",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "The project memory was recorded",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    const first = await syncChatCrystal(store, project);
    const second = await syncChatCrystal(store, project);
    expect(first.total).toBe(1);
    expect(first.imported + first.replaced).toBe(1);
    expect((first as unknown as { items: Array<{ source: string }> }).items[0]?.source).toBe(
      "antigravity",
    );
    expect(second.skipped).toBe(1);
    expect((await purgeChatCrystalProject(store, project)).deleted).toBe(1);
    expect((await syncChatCrystal(store, project)).imported).toBe(1);
  });
});
