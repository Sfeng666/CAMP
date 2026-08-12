import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { importErrorDetail, readJsonLines } from "../src/importers/common.js";

describe("snapshot-safe JSONL ingestion", () => {
  let env: IsolatedCamp;

  beforeEach(() => {
    env = isolatedCamp();
  });

  afterEach(() => env.cleanup());

  it("ignores an unterminated final record until a later stable scan", async () => {
    const path = join(env.root, "live.jsonl");
    writeFileSync(path, '{"id":1}\n{"id":2}');
    const first: number[] = [];
    await readJsonLines(path, (value) => first.push(Number(value.id)));
    expect(first).toEqual([1]);

    appendFileSync(path, "\n");
    const second: number[] = [];
    await readJsonLines(path, (value) => second.push(Number(value.id)));
    expect(second).toEqual([1, 2]);
  });

  it("does not cross the initial file extent when a writer appends during a scan", async () => {
    const path = join(env.root, "growing.jsonl");
    writeFileSync(path, '{"id":1}\n{"id":2}\n');
    const seen: number[] = [];
    await readJsonLines(path, (value) => {
      seen.push(Number(value.id));
      if (value.id === 1) appendFileSync(path, '{"id":3}\n');
    });
    expect(seen).toEqual([1, 2]);
  });

  it("cooperates at bounded record intervals while preserving record order", async () => {
    const path = join(env.root, "cooperative.jsonl");
    writeFileSync(path, Array.from({ length: 5 }, (_, id) => JSON.stringify({ id })).join("\n") + "\n");
    const seen: number[] = [];
    let yields = 0;
    await readJsonLines(
      path,
      (value) => seen.push(Number(value.id)),
      async () => { yields += 1; },
      2,
    );
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(yields).toBe(2);
  });

  it("rejects an in-place rewrite so callers cannot advance a checkpoint", async () => {
    const path = join(env.root, "rewritten.jsonl");
    writeFileSync(path, '{"id":1}\n{"id":2}\n');
    await expect(
      readJsonLines(path, (value) => {
        if (value.id === 1) writeFileSync(path, '{"id":9}\n{"id":8}\n');
      }),
    ).rejects.toMatchObject({ code: "UNSTABLE_SNAPSHOT" });
  });

  it("redacts credentials from structured importer diagnostics", () => {
    const detail = importErrorDetail(
      "codex",
      "scan",
      new Error("request failed with api_key=super-secret-value-123"),
      "/tmp/session.jsonl",
    );
    expect(detail.message).not.toContain("super-secret-value-123");
    expect(detail.message).toContain("[REDACTED]");
  });
});
