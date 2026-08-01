import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { exportLegacyPima } from "../src/legacy.js";
import { sha256 } from "../src/utils.js";

describe("legacy PIMA export", () => {
  let env: IsolatedCamp;

  beforeEach(() => {
    env = isolatedCamp();
  });

  afterEach(() => {
    delete process.env.PIMA_HOME;
    delete process.env.PIMA_CONFIG_HOME;
    env.cleanup();
  });

  it("uses SQLite backup and writes a manifest without mutating the legacy source", async () => {
    const legacyHome = join(env.root, "pima-data");
    const legacyConfig = join(env.root, "pima-config");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(legacyConfig, { recursive: true });
    const source = join(legacyHome, "pima.sqlite");
    const db = new Database(source);
    db.exec("CREATE TABLE projects (id TEXT); INSERT INTO projects(id) VALUES ('legacy-project')");
    db.close();
    writeFileSync(join(legacyHome, "projects.json"), "[]\n");
    writeFileSync(join(legacyConfig, "config.json"), "{}\n");
    const before = sha256(readFileSync(source));
    process.env.PIMA_HOME = legacyHome;
    process.env.PIMA_CONFIG_HOME = legacyConfig;

    const result = await exportLegacyPima(join(env.root, "export"));
    expect(result.counts.projects).toBe(1);
    expect(result.database).toBe("data/pima.sqlite");
    expect(sha256(readFileSync(source))).toBe(before);
    expect(JSON.parse(readFileSync(result.manifest, "utf8")) as { product: string }).toMatchObject({
      product: "legacy-pima",
    });
  });
});
