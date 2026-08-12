import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { importProjectHistory } from "../src/importers/index.js";

describe("per-source importer isolation", () => {
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

  it("records one source failure and continues later sources", async () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const project = setupProject(store, root);
    const summaries = await importProjectHistory(store, project, undefined, [
      {
        source: "codex" as const,
        run: async () => {
          throw Object.assign(new Error("transient read failure"), {
            code: "EAGAIN",
            errno: -11,
            syscall: "read",
          });
        },
      },
      {
        source: "cursor" as const,
        run: async () => ({
          source: "cursor" as const,
          scanned: 1,
          imported: 1,
          replaced: 0,
          skipped: 0,
          quarantined: 0,
          errors: [],
        }),
      },
    ]);
    expect(summaries).toMatchObject([
      { source: "codex", errors: ["transient read failure"] },
      { source: "cursor", imported: 1, errors: [] },
    ]);
    expect(store.sourceFreshness(project.id)).toMatchObject([
      { source: "codex", status: "degraded", error: { code: "EAGAIN", errno: -11, syscall: "read" } },
      { source: "cursor", status: "ok", imported: 1 },
    ]);
  });
});
