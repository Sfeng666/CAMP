import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectClients, integrationHealth } from "./integrations.js";
import { ensureLocalModels } from "./models.js";
function packageVersion(name) {
    const require = createRequire(import.meta.url);
    // Direct dependencies of a scoped, packed CLI are siblings of
    // `@camp-memory/cli`, not children of it. Walk parent directories and check
    // their node_modules folders so health reporting works after a normal npm
    // install as well as from this repository.
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth += 1) {
        const manifestPath = join(directory, "node_modules", name, "package.json");
        if (existsSync(manifestPath)) {
            try {
                return JSON.parse(readFileSync(manifestPath, "utf8")).version ?? null;
            }
            catch {
                return null;
            }
        }
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    try {
        const manifest = require(`${name}/package.json`);
        return manifest.version ?? null;
    }
    catch {
        try {
            let directory = dirname(require.resolve(name));
            for (let depth = 0; depth < 8; depth += 1) {
                const path = join(directory, "package.json");
                if (existsSync(path)) {
                    const manifest = JSON.parse(readFileSync(path, "utf8"));
                    if (manifest.name === name)
                        return manifest.version ?? null;
                }
                const parent = dirname(directory);
                if (parent === directory)
                    break;
                directory = parent;
            }
        }
        catch {
            // Fall through to a visible missing-package diagnostic.
        }
        return null;
    }
}
async function ollamaCheck() {
    const models = ensureLocalModels(false);
    if (!models.available) {
        return {
            name: "ollama",
            status: "degraded",
            detail: `${models.actions.join("; ")}; lexical search remains available`,
            repairable: false,
        };
    }
    const detail = JSON.stringify({
        installed: models.installed,
        manifests: models.manifests,
        missing: models.missing,
        reindexRequired: models.reindexRequired,
    });
    return models.missing.length || models.reindexRequired
        ? { name: "ollama", status: "degraded", detail, repairable: models.missing.length > 0 }
        : { name: "ollama", status: "ok", detail };
}
export async function runDoctor(store) {
    const checks = [];
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 18);
    checks.push({
        name: "node",
        status: supported ? "ok" : "error",
        detail: `${process.version}; CAMP requires >=22.18.0`,
    });
    try {
        const row = store.db.prepare("PRAGMA integrity_check").get();
        checks.push({
            name: "database",
            status: row.integrity_check === "ok" ? "ok" : "error",
            detail: row.integrity_check,
        });
    }
    catch (error) {
        checks.push({ name: "database", status: "error", detail: error instanceof Error ? error.message : String(error) });
    }
    const mode = statSync(store.paths.home).mode & 0o777;
    checks.push({
        name: "permissions",
        status: mode & 0o077 ? "error" : "ok",
        detail: `${store.paths.home} mode ${mode.toString(8)}`,
    });
    for (const [name, expected] of [
        ["chatcrystal", "0.5.8"],
        ["memorix", "1.3.1"],
        ["better-sqlite3", "12.11.1"],
    ]) {
        const version = packageVersion(name);
        checks.push({
            name,
            status: version === expected ? "ok" : "error",
            detail: version ? `${version}; pinned ${expected}` : "not installed",
        });
    }
    checks.push(await ollamaCheck());
    for (const client of integrationHealth(store)) {
        const installed = detectClients().find((item) => item.name === client.client)?.installed;
        checks.push({
            name: `integration:${client.client}`,
            status: client.status,
            detail: client.detail,
            ...(installed === undefined ? {} : { repairable: client.status !== "ok" && installed }),
        });
    }
    return checks;
}
//# sourceMappingURL=doctor.js.map