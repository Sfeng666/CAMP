import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import type { EvidenceRecord, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../paths.js";
import { stableId } from "../utils.js";
import { findCommand } from "../platform.js";

function memorixBinary(): string | null {
  const local = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "memorix.cmd" : "memorix",
  );
  if (existsSync(local)) return local;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const bundled = join(directory, "node_modules", "memorix", "dist", "cli", "index.js");
    if (existsSync(bundled)) return bundled;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // A packed scoped package lives below node_modules/@camp-memory/cli, so its
  // sibling node_modules directory is not two levels above this file. Resolve
  // the pinned dependency through Node instead of assuming an installation
  // layout; this keeps `npm install -g @camp-memory/cli` self-contained.
  try {
    const entry = createRequire(import.meta.url).resolve("memorix");
    const bundled = join(dirname(entry), "cli", "index.js");
    if (existsSync(bundled)) return bundled;
  } catch {
    // Fall through to an explicitly user-provided executable for development.
  }
  return findCommand("memorix") ?? findCommand("memorix.cmd");
}

function memorixType(record: EvidenceRecord): string {
  if (record.kind === "decision") return "decision";
  if (record.kind === "verification") return "discovery";
  if (record.kind === "constraint") return "warning";
  return "what-changed";
}

function memorixEnvironment(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    MEMORIX_DATA_DIR: dataDir,
    MEMORIX_AUDIT_FILE: join(dataDir, "audit.json"),
    MEMORIX_AUTO_UPDATE: "off",
  };
}

function processText(value: string | Buffer | null | undefined): string {
  return typeof value === "string" ? value : value?.toString("utf8") ?? "";
}

function processError(result: { stderr?: string | Buffer | null; stdout?: string | Buffer | null; status: number | null }): string {
  const stderr = processText(result.stderr);
  const stdout = processText(result.stdout);
  return stderr.trim() || stdout.trim() || `memorix exited ${result.status}`;
}

function runMemorix(
  binary: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) {
  // npm's Windows shims are .cmd files. When dependency resolution returns
  // Memorix's JavaScript entry point directly, launch it through the current
  // Node executable instead of relying on Windows file association.
  const script = binary.endsWith(".js");
  return spawnSync(script ? process.execPath : binary, script ? [binary, ...args] : args, options);
}

interface MemorixObservationRow {
  id: number;
  title: string;
  narrative: string;
  status: string;
}

export function matchMemorixObservations(
  records: EvidenceRecord[],
  observations: MemorixObservationRow[],
): {
  matched: Array<{ record: EvidenceRecord; observation: MemorixObservationRow }>;
  unmatched: EvidenceRecord[];
} {
  const matched: Array<{ record: EvidenceRecord; observation: MemorixObservationRow }> = [];
  const unmatched: EvidenceRecord[] = [];
  for (const record of records) {
    const observation = observations.find(
      (candidate) =>
        candidate.title === record.title && candidate.narrative === record.content,
    );
    if (observation) matched.push({ record, observation });
    else unmatched.push(record);
  }
  return {
    matched: [
      ...new Map(
        matched.map((pair) => [pair.observation.id, pair]),
      ).values(),
    ],
    unmatched,
  };
}

export function queueMemorix(store: CampStore, project: ProjectRegistration, record: EvidenceRecord): void {
  if (project.kind !== "git") return;
  store.enqueue(
    project.id,
    "memorix",
    "remember",
    record,
    stableId("memorix", project.id, "remember", record.id, record.contentHash),
  );
}

export function prepareMemorixMigration(
  store: CampStore,
  project: ProjectRegistration,
): { pending: boolean; expected: number; manifestHash: string | null } {
  if (project.kind !== "git" || project.migrationState !== "pending-memorix") {
    return { pending: false, expected: 0, manifestHash: null };
  }
  const records = store.listEvidence(project.id);
  for (const record of records) queueMemorix(store, project, record);
  const hashes = records.map((record) => record.contentHash);
  store.beginMigrationAudit(project.id, "memorix", hashes);
  const audit = store.migrationAudit(project.id);
  return {
    pending: true,
    expected: records.length,
    manifestHash: typeof audit?.manifest_hash === "string" ? audit.manifest_hash : null,
  };
}

export function finalizeMemorixMigration(
  store: CampStore,
  project: ProjectRegistration,
): boolean {
  if (project.kind !== "git" || project.migrationState !== "pending-memorix") return false;
  const expected = store.listEvidence(project.id).map((record) => record.contentHash);
  const rows = store.db
    .prepare("SELECT payload_json FROM outbox WHERE project_id=? AND backend='memorix' AND action='remember' AND completed_at IS NOT NULL")
    .all(project.id) as Array<{ payload_json: string }>;
  const completedHashes = rows.flatMap((row) => {
    try {
      const record = JSON.parse(row.payload_json) as EvidenceRecord;
      return record.contentHash ? [record.contentHash] : [];
    } catch {
      return [];
    }
  });
  return store.verifyMigration(project.id, "memorix", expected, completedHashes);
}

export function flushMemorix(
  store: CampStore,
  project: ProjectRegistration,
): { completed: number; failed: number; unavailable: boolean; errors: string[] } {
  const binary = memorixBinary();
  if (!binary) return { completed: 0, failed: 0, unavailable: true, errors: ["memorix binary not found"] };
  let completed = 0;
  let failed = 0;
  const errors: string[] = [];
  const dataDir = join(store.paths.backendDir, "memorix");
  ensurePrivateDirectory(dataDir);
  for (const row of store.pendingOutbox("memorix")) {
    if (row.project_id !== project.id || row.action !== "remember") continue;
    const record = JSON.parse(String(row.payload_json)) as EvidenceRecord;
    const result = runMemorix(
      binary,
      [
        "remember",
        record.content,
        "--title",
        record.title,
        "--type",
        memorixType(record),
        "--visibility",
        "project",
        "--json",
      ],
      {
        cwd: project.rootPath,
        env: memorixEnvironment(dataDir),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status === 0) {
      store.completeOutbox(String(row.id));
      completed += 1;
    } else {
      const error = processError(result);
      store.failOutbox(String(row.id), error);
      failed += 1;
      errors.push(error);
    }
    for (const name of ["memorix.db", "memorix.db-wal", "memorix.db-shm", "audit.json"]) {
      ensurePrivateFile(join(dataDir, name));
    }
  }
  for (const name of ["memorix.db", "memorix.db-wal", "memorix.db-shm", "audit.json"]) {
    ensurePrivateFile(join(dataDir, name));
  }
  return { completed, failed, unavailable: false, errors };
}

/**
 * Remove every successfully mirrored CAMP record for one exact project before
 * canonical purge. The public Memorix lifecycle archives each exact match
 * first; CAMP then deletes only those verified backend rows and records a
 * restart-safe receipt before canonical data is removed.
 */
export function archiveMemorixProjectRecords(
  store: CampStore,
  project: ProjectRegistration,
): { deleted: number; alreadyDeleted: number; unavailable: boolean; errors: string[] } {
  if (project.kind !== "git") {
    return { deleted: 0, alreadyDeleted: 0, unavailable: false, errors: [] };
  }
  const completedRows = store.db
    .prepare(`
      SELECT payload_json FROM outbox
      WHERE project_id=? AND backend='memorix' AND action='remember'
        AND completed_at IS NOT NULL
    `)
    .all(project.id) as Array<{ payload_json: string }>;
  const parsedRecords = completedRows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as EvidenceRecord];
    } catch {
      return [];
    }
  });
  const records = [
    ...new Map(parsedRecords.map((record) => [record.id, record])).values(),
  ];
  const initialReceipts = store.backendPurgeReceipts(project.id, "memorix");
  if (!records.length) {
    return {
      deleted: 0,
      alreadyDeleted: initialReceipts.filter((receipt) => receipt.state === "deleted").length,
      unavailable: false,
      errors: [],
    };
  }

  const binary = memorixBinary();
  if (!binary) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: ["memorix binary not found; canonical CAMP data was not purged"],
    };
  }
  const dataDir = join(store.paths.backendDir, "memorix");
  const databasePath = join(dataDir, "memorix.db");
  if (!existsSync(databasePath)) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: ["Memorix database is missing; canonical CAMP data was not purged"],
    };
  }
  const context = runMemorix(
    binary,
    ["memory", "recent", "--limit", "1", "--json", "--cwd", project.rootPath],
    {
      cwd: project.rootPath,
      env: memorixEnvironment(dataDir),
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (context.status !== 0) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: [processError(context) || "Memorix project resolution failed"],
    };
  }
  let memorixProjectId = "";
  try {
    const payload = JSON.parse(processText(context.stdout)) as { project?: { id?: unknown } };
    if (typeof payload.project?.id === "string") memorixProjectId = payload.project.id;
  } catch {
    // The explicit error below preserves canonical data for a safe retry.
  }
  if (!memorixProjectId) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: ["Memorix did not return an exact project identity; canonical CAMP data was not purged"],
    };
  }

  const backend = new Database(databasePath, { readonly: true, fileMustExist: true });
  let observations: MemorixObservationRow[];
  try {
    observations = backend
      .prepare("SELECT id, title, narrative, status FROM observations WHERE projectId=?")
      .all(memorixProjectId) as MemorixObservationRow[];
  } finally {
    backend.close();
  }
  const receipts = new Map(
    initialReceipts.map((receipt) => [receipt.recordId, receipt]),
  );
  let alreadyDeleted = initialReceipts.filter((receipt) => receipt.state === "deleted").length;
  const pendingPairs: Array<{
    record: EvidenceRecord;
    observation: MemorixObservationRow;
  }> = [];
  const unmatchedReceiptErrors: string[] = [];
  const unreceipted: EvidenceRecord[] = [];
  for (const record of records) {
    const receipt = receipts.get(record.id);
    if (receipt?.state === "deleted") continue;
    if (!receipt) {
      unreceipted.push(record);
      continue;
    }
    const observation = observations.find(
      (candidate) => String(candidate.id) === receipt.backendRecordId,
    );
    if (!observation) {
      store.completeBackendPurgeReceipt(project.id, "memorix", record.id);
      alreadyDeleted += 1;
      continue;
    }
    if (observation.title !== record.title || observation.narrative !== record.content) {
      unmatchedReceiptErrors.push(record.id);
      continue;
    }
    pendingPairs.push({ record, observation });
  }
  if (unmatchedReceiptErrors.length) {
    return {
      deleted: 0,
      alreadyDeleted,
      unavailable: false,
      errors: [
        `Refused purge because ${unmatchedReceiptErrors.length} pending Memorix purge receipt(s) no longer match their CAMP records`,
      ],
    };
  }
  const selection = matchMemorixObservations(unreceipted, observations);
  if (selection.unmatched.length) {
    return {
      deleted: 0,
      alreadyDeleted,
      unavailable: false,
      errors: [
        `Refused purge because ${selection.unmatched.length} completed CAMP record(s) could not be matched exactly in Memorix`,
      ],
    };
  }
  for (const pair of selection.matched) {
    store.beginBackendPurgeReceipt(
      project.id,
      "memorix",
      pair.record.id,
      String(pair.observation.id),
    );
  }
  const pairs = [...pendingPairs, ...selection.matched];
  if (!pairs.length) {
    return { deleted: 0, alreadyDeleted, unavailable: false, errors: [] };
  }
  const pendingArchive = pairs.filter(
    (pair) => pair.observation.status !== "archived",
  );
  if (pendingArchive.length) {
    const result = runMemorix(
      binary,
      [
        "memory",
        "resolve",
        "--ids",
        pendingArchive.map((pair) => pair.observation.id).join(","),
        "--status",
        "archived",
        "--json",
        "--cwd",
        project.rootPath,
      ],
      {
        cwd: project.rootPath,
        env: memorixEnvironment(dataDir),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    ensurePrivateFile(databasePath);
    if (result.status !== 0) {
      return {
        deleted: 0,
        alreadyDeleted,
        unavailable: false,
        errors: [processError(result)],
      };
    }
  }
  const verify = new Database(databasePath, { readonly: true, fileMustExist: true });
  let archived = 0;
  try {
    const placeholders = pairs.map(() => "?").join(",");
    const row = verify
      .prepare(`SELECT count(*) AS count FROM observations WHERE id IN (${placeholders}) AND status='archived'`)
      .get(...pairs.map((pair) => pair.observation.id)) as { count: number };
    archived = Number(row.count);
  } finally {
    verify.close();
  }
  if (archived !== pairs.length) {
    return {
        deleted: 0,
        alreadyDeleted,
        unavailable: false,
        errors: ["Memorix archival verification count did not match; canonical CAMP data was not purged"],
    };
  }

  const writable = new Database(databasePath, { fileMustExist: true });
  let deleted = 0;
  try {
    const ids = pairs.map((pair) => pair.observation.id);
    const placeholders = ids.map(() => "?").join(",");
    const remove = writable.transaction(() => {
      writable
        .prepare(`DELETE FROM observation_code_refs WHERE observationId IN (${placeholders})`)
        .run(...ids);
      return writable
        .prepare(`DELETE FROM observations WHERE projectId=? AND status='archived' AND id IN (${placeholders})`)
        .run(memorixProjectId, ...ids).changes;
    });
    deleted = remove();
  } finally {
    writable.close();
    ensurePrivateFile(databasePath);
  }
  if (deleted !== pairs.length) {
    return {
      deleted,
      alreadyDeleted,
      unavailable: false,
      errors: ["Memorix deletion verification count did not match; canonical CAMP data was not purged"],
    };
  }
  for (const pair of pairs) {
    store.completeBackendPurgeReceipt(project.id, "memorix", pair.record.id);
  }
  return { deleted, alreadyDeleted, unavailable: false, errors: [] };
}
