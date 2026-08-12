import Database from "better-sqlite3";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { bootstrapDatabase } from "../src/bootstrap.js";
import { ensureCampDirectories, getCampPaths } from "../src/paths.js";
import { hostPlatform } from "../src/platform.js";

describe("exclusive schema bootstrap", () => {
  let env: IsolatedCamp;

  beforeEach(() => {
    env = isolatedCamp();
  });

  afterEach(() => env.cleanup());

  it("backs up schema v1 before migrating once to schema v2", async () => {
    const paths = ensureCampDirectories(getCampPaths());
    const legacy = new Database(paths.database);
    legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
    legacy.close();

    const first = await bootstrapDatabase();
    expect(first.migrated).toBe(true);
    expect(first.backup && existsSync(first.backup)).toBe(true);
    // Windows exposes ACLs rather than POSIX permission masks. CAMP requests
    // a private ACL there, but a Unix-mode assertion would report a synthetic
    // nonzero mask even when the backup was written correctly.
    if (hostPlatform() !== "windows") expect(statSync(first.backup!).mode & 0o077).toBe(0);
    const migrated = new Database(paths.database, { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").pluck().get()).toBe("2");
    migrated.close();

    expect(await bootstrapDatabase()).toEqual({ migrated: false, backup: null });
  });

  it("fails closed while another live process owns the migration lock", async () => {
    const paths = ensureCampDirectories(getCampPaths());
    writeFileSync(paths.migrationLock, String(process.pid), { mode: 0o600 });
    await expect(bootstrapDatabase()).rejects.toMatchObject({ code: "CAMP_MIGRATION_BUSY" });
    unlinkSync(paths.migrationLock);
    expect((await bootstrapDatabase()).migrated).toBe(true);
  });
});
