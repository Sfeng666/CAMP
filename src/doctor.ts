import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck } from "./types.js";
import type { CampStore } from "./store.js";
import { detectClients, integrationHealth } from "./integrations.js";
import { ensureLocalModels } from "./models.js";
import { CHATCRYSTAL_BASELINE } from "./backends/chatcrystal.js";
import { MEMORIX_BASELINE } from "./backends/memorix.js";

function packageVersion(name: string): string | null {
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
        return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  try {
    const manifest = require(`${name}/package.json`) as { version?: string };
    return manifest.version ?? null;
  } catch {
    try {
      let directory = dirname(require.resolve(name));
      for (let depth = 0; depth < 8; depth += 1) {
        const path = join(directory, "package.json");
        if (existsSync(path)) {
          const manifest = JSON.parse(readFileSync(path, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (manifest.name === name) return manifest.version ?? null;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {
      // Fall through to a visible missing-package diagnostic.
    }
    return null;
  }
}

async function ollamaCheck(): Promise<DoctorCheck> {
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

export async function runDoctor(store: CampStore): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 18);
  checks.push({
    name: "node",
    status: supported ? "ok" : "error",
    detail: `${process.version}; CAMP requires >=22.18.0`,
  });
  try {
    const row = store.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    checks.push({
      name: "database",
      status: row.integrity_check === "ok" ? "ok" : "error",
      detail: row.integrity_check,
    });
  } catch (error) {
    checks.push({ name: "database", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  const mode = statSync(store.paths.home).mode & 0o777;
  checks.push({
    name: "permissions",
    status: mode & 0o077 ? "error" : "ok",
    detail: `${store.paths.home} mode ${mode.toString(8)}`,
  });
  checks.push({
    name: "chatcrystal",
    status: "ok",
    detail: `narrow local ingest adapter; source-compatible baseline ${CHATCRYSTAL_BASELINE}`,
  });
  checks.push({
    name: "memorix",
    status: "ok",
    detail: `narrow curated-memory adapter; source-compatible baseline ${MEMORIX_BASELINE}`,
  });
  for (const [name, expected] of [["better-sqlite3", "12.11.1"]] as const) {
    const version = packageVersion(name);
    checks.push({
      name,
      status: version === expected ? "ok" : "error",
      detail: version ? `${version}; pinned ${expected}` : "not installed",
    });
  }
  checks.push(await ollamaCheck());
  checks.push({
    name: "daemon-single-writer",
    status: "ok",
    detail: `PID ${process.pid} owns the only writable CAMP database handle; CLI, MCP, and hooks use authenticated RPC`,
  });
  for (const project of store.listProjects()) {
    const freshness = store.sourceFreshness(project.id);
    if (!freshness.length) {
      checks.push({
        name: `freshness:${project.id}`,
        status: "degraded",
        detail: "No source synchronization has completed",
      });
    }
    for (const source of freshness) {
      const current =
        source.status === "ok" && source.lastSuccessfulScanAt !== null && (source.lagSeconds ?? Infinity) <= 120;
      checks.push({
        name: `freshness:${project.id}:${source.source}`,
        status: current ? "ok" : "degraded",
        detail: JSON.stringify({
          status: source.status,
          lastAttemptAt: source.lastAttemptAt,
          lastSuccessfulScanAt: source.lastSuccessfulScanAt,
          lagSeconds: source.lagSeconds,
          error: source.error,
        }),
      });
    }
  }
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
