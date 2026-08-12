import Database from "better-sqlite3";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { CampStore } from "./store.js";
import { ensureCampDirectories, ensurePrivateFile, getCampPaths } from "./paths.js";
import { SCHEMA_VERSION } from "./types.js";
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function legacyWriterPid() {
    const paths = getCampPaths();
    for (const path of [paths.daemonLock, join(paths.home, "daemon.lock")]) {
        if (!existsSync(path))
            continue;
        try {
            const pid = Number(readFileSync(path, "utf8").trim());
            if (alive(pid))
                return pid;
        }
        catch {
            // A malformed stale lock is ignored and replaced by the daemon.
        }
    }
    return null;
}
function schemaVersion(path) {
    if (!existsSync(path))
        return 0;
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const row = probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        return Number(row?.value ?? 0);
    }
    catch {
        return 0;
    }
    finally {
        probe.close();
    }
}
function acquireMigrationLock(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const descriptor = openSync(path, "wx", 0o600);
            writeFileSync(descriptor, String(process.pid));
            return descriptor;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            let owner = 0;
            try {
                owner = Number(readFileSync(path, "utf8").trim());
            }
            catch {
                // Treat an unreadable/malformed lock as stale only when no live owner is known.
            }
            if (alive(owner)) {
                throw Object.assign(new Error(`CAMP schema migration is already owned by PID ${owner}`), { code: "CAMP_MIGRATION_BUSY" });
            }
            unlinkSync(path);
        }
    }
    throw Object.assign(new Error("CAMP could not acquire the schema migration lock"), {
        code: "CAMP_MIGRATION_BUSY",
    });
}
export async function bootstrapDatabase() {
    const paths = ensureCampDirectories(getCampPaths());
    let current = schemaVersion(paths.database);
    if (current >= SCHEMA_VERSION)
        return { migrated: false, backup: null };
    const lock = acquireMigrationLock(paths.migrationLock);
    try {
        // Another bootstrap may have completed while this caller waited for the lock.
        current = schemaVersion(paths.database);
        if (current >= SCHEMA_VERSION)
            return { migrated: false, backup: null };
        const writer = legacyWriterPid();
        if (writer) {
            throw new Error(`CAMP daemon PID ${writer} still owns the pre-v${SCHEMA_VERSION} database; run camp upgrade --apply`);
        }
        let backup = null;
        if (existsSync(paths.database) && current > 0) {
            const database = new Database(paths.database);
            try {
                database.pragma("wal_checkpoint(TRUNCATE)");
                const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
                backup = join(paths.backupDir, `camp-schema-v${current}-${stamp}.sqlite`);
                await database.backup(backup);
                ensurePrivateFile(backup);
            }
            finally {
                database.close();
            }
        }
        const store = new CampStore(paths.database);
        store.close();
        return { migrated: true, backup };
    }
    finally {
        closeSync(lock);
        if (existsSync(paths.migrationLock))
            unlinkSync(paths.migrationLock);
    }
}
//# sourceMappingURL=bootstrap.js.map