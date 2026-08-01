import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { ensurePrivateDirectory, getCampPaths } from "./paths.js";
import { atomicWrite, nowIso, sha256 } from "./utils.js";

interface LegacyFile {
  path: string;
  size: number;
  sha256: string;
}

export interface LegacyExportResult {
  source: string;
  output: string;
  database: string | null;
  counts: Record<string, number>;
  files: LegacyFile[];
  manifest: string;
}

function timestampForPath(): string {
  return nowIso().replaceAll(":", "-").replaceAll(".", "-");
}

function listFiles(root: string, current = root): LegacyFile[] {
  if (!existsSync(current)) return [];
  const files: LegacyFile[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) {
      files.push({
        path: relative(root, path),
        size: statSync(path).size,
        sha256: sha256(readFileSync(path)),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function tableCounts(database: InstanceType<typeof Database>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ["projects", "sessions", "messages", "evidence", "quarantine", "outbox", "checkpoints"]) {
    const found = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!found) continue;
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

/**
 * Preserve a legacy PIMA installation without trusting a copy of its live WAL.
 * The result is intentionally an offline evidence export; CAMP reimports native
 * agent histories into a clean store rather than silently merging old records.
 */
export async function exportLegacyPima(output?: string): Promise<LegacyExportResult> {
  const home = resolve(process.env.PIMA_HOME ?? join(homedir(), ".local", "share", "pima"));
  const config = resolve(process.env.PIMA_CONFIG_HOME ?? join(homedir(), ".config", "pima"));
  if (!existsSync(home) && !existsSync(config)) {
    throw new Error("No legacy PIMA data was found; nothing was exported");
  }
  const destination = resolve(output ?? join(getCampPaths().backupDir, `legacy-pima-${timestampForPath()}`));
  if (existsSync(destination)) throw new Error(`Legacy export destination already exists: ${destination}`);
  ensurePrivateDirectory(destination);

  const sourceDatabase = join(home, "pima.sqlite");
  const destinationDatabase = join(destination, "data", "pima.sqlite");
  const counts: Record<string, number> = {};
  let database: string | null = null;
  if (existsSync(sourceDatabase)) {
    ensurePrivateDirectory(join(destination, "data"));
    const source = new Database(sourceDatabase, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      source.pragma("query_only = ON");
      Object.assign(counts, tableCounts(source));
      await source.backup(destinationDatabase);
      database = relative(destination, destinationDatabase);
    } finally {
      source.close();
    }
  }

  const copies: Array<[string, string]> = [
    [join(home, "archive"), join(destination, "data", "archive")],
    [join(home, "backends"), join(destination, "data", "backends")],
    [join(home, "spool"), join(destination, "data", "spool")],
    [join(home, "backups"), join(destination, "data", "backups")],
    [join(home, "projects.json"), join(destination, "data", "projects.json")],
    [join(home, "integrations.json"), join(destination, "data", "integrations.json")],
    [config, join(destination, "config")],
  ];
  for (const [source, target] of copies) {
    if (!existsSync(source)) continue;
    cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true });
  }

  const files = listFiles(destination);
  const manifest = join(destination, "manifest.json");
  atomicWrite(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      product: "legacy-pima",
      exportedAt: nowIso(),
      source: { home, config },
      database,
      counts,
      files,
      contentHash: sha256(JSON.stringify({ database, counts, files })),
    }, null, 2)}\n`,
  );
  return { source: home, output: destination, database, counts, files: listFiles(destination), manifest };
}
