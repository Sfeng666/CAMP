import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { hybridSearch, syncSemanticIndex } from "../src/semantic.js";

describe("optional local semantic index", () => {
  let env: IsolatedCamp;
  let store: CampStore;

  beforeEach(() => {
    env = isolatedCamp();
    store = new CampStore();
    writeFileSync(
      join(env.config, "models.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        summaryModel: "qwen3:4b",
        embeddingModel: "qwen3-embedding:0.6b",
        manifests: { "qwen3-embedding:0.6b": "digest-fixture" },
        reindexRequired: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        const embeddings = body.input.map((value) => [
          /cursor/i.test(value) ? 1 : 0,
          /outreach/i.test(value) ? 1 : 0,
          0.1,
        ]);
        return new Response(JSON.stringify({ embeddings }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    env.cleanup();
  });

  it("indexes through loopback Ollama and fuses semantic with lexical results", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "{}\n");
    store.storeSession({
      schemaVersion: SCHEMA_VERSION,
      source: "cursor",
      nativeId: "cursor-session",
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
          content: "How should a huge IDE database be handled?",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          sequence: 1,
          role: "assistant",
          kind: "message",
          content: "Use a read-only Cursor query scoped to composer keys.",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    const indexed = await syncSemanticIndex(store, project, 32);
    expect(indexed.indexed).toBe(2);
    expect(indexed.degraded).toBe(false);
    const hits = await hybridSearch(store, project.id, "safe IDE storage strategy", "all", 5);
    expect(hits.some((hit) => /Cursor query/.test(hit.content))).toBe(true);
    expect(store.projectStatus(project.id).semanticDocuments).toBe(2);
  });

  it("does not use stale embeddings until an explicit model reindex is acknowledged", async () => {
    const root = join(env.root, "project");
    mkdirSync(root);
    const project = setupProject(store, root);
    writeFileSync(
      join(env.config, "models.json"),
      `${JSON.stringify({
        embeddingModel: "qwen3-embedding:0.6b",
        manifests: { "qwen3-embedding:0.6b": "changed-digest" },
        reindexRequired: true,
      })}\n`,
    );
    expect(await syncSemanticIndex(store, project)).toEqual({
      indexed: 0,
      pending: 0,
      degraded: true,
    });
  });
});
