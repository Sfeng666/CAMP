import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import type { EvidenceRecord, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../paths.js";
import { stableId } from "../utils.js";

/**
 * CAMP mirrors curated Git-project evidence into the stable observation
 * contract used by Memorix 1.3.1. The upstream package remains a pinned
 * compatibility-test baseline, but its CLI, model runtimes, dashboard, and
 * optional native/image dependencies are not installed in production.
 */
export const MEMORIX_BASELINE = "1.3.1";

interface MemorixObservationRow {
  id: number;
  title: string;
  narrative: string;
  status: string;
}

const MEMORIX_SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id                 INTEGER PRIMARY KEY,
  entityName         TEXT NOT NULL,
  type               TEXT NOT NULL,
  title              TEXT NOT NULL,
  narrative          TEXT NOT NULL DEFAULT '',
  facts              TEXT NOT NULL DEFAULT '[]',
  filesModified      TEXT NOT NULL DEFAULT '[]',
  concepts           TEXT NOT NULL DEFAULT '[]',
  tokens             INTEGER NOT NULL DEFAULT 0,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT,
  projectId          TEXT NOT NULL,
  hasCausalLanguage  INTEGER DEFAULT 0,
  topicKey           TEXT,
  revisionCount      INTEGER DEFAULT 1,
  sessionId          TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  progress           TEXT,
  source             TEXT DEFAULT 'agent',
  commitHash         TEXT,
  relatedCommits     TEXT,
  relatedEntities    TEXT,
  sourceDetail       TEXT,
  valueCategory      TEXT,
  admissionState     TEXT,
  admissionReason    TEXT,
  visibility         TEXT,
  sharedWithAgentIds TEXT,
  createdByAgentId   TEXT,
  writeGeneration    INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS observation_code_refs (
  id                 TEXT PRIMARY KEY,
  projectId          TEXT NOT NULL,
  observationId      INTEGER NOT NULL,
  fileId             TEXT,
  symbolId           TEXT,
  capturedFileHash   TEXT,
  capturedSymbolHash TEXT,
  status             TEXT NOT NULL,
  reason             TEXT,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_projectId
  ON observations(projectId);
CREATE INDEX IF NOT EXISTS idx_observations_topicKey
  ON observations(projectId, topicKey);
CREATE INDEX IF NOT EXISTS idx_observations_status
  ON observations(status);
CREATE INDEX IF NOT EXISTS idx_observation_code_refs_obs
  ON observation_code_refs(projectId, observationId);
INSERT OR IGNORE INTO meta(key, value) VALUES ('storage_generation', '0');
`;

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(column)) {
    throw new Error("Unsafe Memorix schema identifier");
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function openMemorixDatabase(store: CampStore): Database.Database {
  const dataDir = join(store.paths.backendDir, "memorix");
  ensurePrivateDirectory(dataDir);
  const databasePath = join(dataDir, "memorix.db");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(MEMORIX_SCHEMA);
  ensureColumn(database, "observations", "createdByAgentId", "TEXT");
  ensureColumn(database, "observations", "writeGeneration", "INTEGER DEFAULT 0");
  ensurePrivateFile(databasePath);
  return database;
}

function memorixProjectId(project: ProjectRegistration): string {
  return project.memorixKey ?? `local/${basename(project.rootPath)}`;
}

function memorixType(record: EvidenceRecord): string {
  if (record.kind === "decision") return "decision";
  if (record.kind === "verification") return "discovery";
  if (record.kind === "constraint") return "warning";
  return "what-changed";
}

function eligibleForMemorix(record: EvidenceRecord): boolean {
  return record.state !== "quarantined";
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

export function queueMemorix(
  store: CampStore,
  project: ProjectRegistration,
  record: EvidenceRecord,
): void {
  if (project.kind !== "git" || !eligibleForMemorix(record)) return;
  store.enqueue(
    project.id,
    "memorix",
    "remember",
    record,
    stableId("memorix", project.id, "remember", record.id, record.contentHash),
  );
}

function eligibleProjectRecords(store: CampStore, projectId: string): EvidenceRecord[] {
  return store.listEvidence(projectId).filter(eligibleForMemorix);
}

export function prepareMemorixMigration(
  store: CampStore,
  project: ProjectRegistration,
): { pending: boolean; expected: number; manifestHash: string | null } {
  if (project.kind !== "git" || project.migrationState !== "pending-memorix") {
    return { pending: false, expected: 0, manifestHash: null };
  }
  const records = eligibleProjectRecords(store, project.id);
  for (const record of records) queueMemorix(store, project, record);
  store.beginMigrationAudit(
    project.id,
    "memorix",
    records.map((record) => record.contentHash),
  );
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
  const expected = eligibleProjectRecords(store, project.id).map(
    (record) => record.contentHash,
  );
  const rows = store.db
    .prepare(
      "SELECT payload_json FROM outbox WHERE project_id=? AND backend='memorix' AND action='remember' AND completed_at IS NOT NULL",
    )
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

export interface MemorixFlushResult {
  completed: number;
  failed: number;
  pending: number;
  unavailable: boolean;
  errors: string[];
}

export async function flushMemorix(
  store: CampStore,
  project: ProjectRegistration,
  cooperate: () => Promise<void> = async () => undefined,
  limit = 1,
): Promise<MemorixFlushResult> {
  const projectRows = () =>
    store.pendingOutbox("memorix").filter(
      (row) => row.project_id === project.id && row.action === "remember",
    );
  let database: Database.Database;
  try {
    database = openMemorixDatabase(store);
  } catch (error) {
    return {
      completed: 0,
      failed: 0,
      pending: projectRows().length,
      unavailable: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let completed = 0;
  let failed = 0;
  const errors: string[] = [];
  const projectKey = memorixProjectId(project);
  const rows = projectRows().slice(0, Math.max(0, Math.floor(limit)));
  try {
    for (const row of rows) {
      await cooperate();
      try {
        const record = JSON.parse(String(row.payload_json)) as EvidenceRecord;
        if (!eligibleForMemorix(record)) {
          store.completeOutbox(String(row.id));
          completed += 1;
          continue;
        }
        const topicKey = `camp:${record.id}:${record.contentHash}`;
        database.transaction(() => {
          const existing = database
            .prepare(
              "SELECT id, title, narrative FROM observations WHERE projectId=? AND topicKey=? LIMIT 1",
            )
            .get(projectKey, topicKey) as
            | { id: number; title: string; narrative: string }
            | undefined;
          if (existing) {
            if (existing.title !== record.title || existing.narrative !== record.content) {
              throw new Error("Memorix topic key collision refused");
            }
            return;
          }
          const generationRow = database
            .prepare("SELECT value FROM meta WHERE key='storage_generation'")
            .get() as { value?: string } | undefined;
          const generation = Number.parseInt(generationRow?.value ?? "0", 10) + 1;
          database
            .prepare(
              `INSERT INTO observations (
                entityName, type, title, narrative, facts, filesModified,
                concepts, tokens, createdAt, updatedAt, projectId,
                hasCausalLanguage, topicKey, revisionCount, sessionId, status,
                progress, source, commitHash, relatedCommits, relatedEntities,
                sourceDetail, valueCategory, admissionState, admissionReason,
                visibility, sharedWithAgentIds, createdByAgentId, writeGeneration
              ) VALUES (
                @entityName, @type, @title, @narrative, @facts, @filesModified,
                @concepts, @tokens, @createdAt, @updatedAt, @projectId,
                0, @topicKey, 1, @sessionId, 'active',
                NULL, 'camp', @commitHash, NULL, NULL,
                @sourceDetail, @valueCategory, @admissionState, NULL,
                'project', NULL, 'camp', @writeGeneration
              )`,
            )
            .run({
              entityName: `camp:${project.id}`,
              type: memorixType(record),
              title: record.title,
              narrative: record.content,
              facts: "[]",
              filesModified: JSON.stringify(record.relevantFiles),
              concepts: JSON.stringify([record.kind, record.state]),
              tokens: Math.max(1, Math.ceil(record.content.length / 4)),
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              projectId: projectKey,
              topicKey,
              sessionId: record.sourceSessionId,
              commitHash: record.commit,
              sourceDetail: JSON.stringify({
                campProjectId: project.id,
                campEvidenceId: record.id,
                contentHash: record.contentHash,
                sourceAgent: record.sourceAgent,
                sourceUri: record.sourceUri,
                confidence: record.confidence,
                worktreeFingerprint: record.worktreeFingerprint,
              }),
              valueCategory: record.kind,
              admissionState: record.state,
              writeGeneration: generation,
            });
          database
            .prepare("UPDATE meta SET value=? WHERE key='storage_generation'")
            .run(String(generation));
        })();
        store.completeOutbox(String(row.id));
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.failOutbox(String(row.id), message);
        failed += 1;
        errors.push(message);
      }
    }
  } finally {
    database.close();
    ensurePrivateFile(join(store.paths.backendDir, "memorix", "memorix.db"));
  }
  return {
    completed,
    failed,
    pending: projectRows().length,
    unavailable: false,
    errors,
  };
}

export function archiveMemorixProjectRecords(
  store: CampStore,
  project: ProjectRegistration,
): { deleted: number; alreadyDeleted: number; unavailable: boolean; errors: string[] } {
  if (project.kind !== "git") {
    return { deleted: 0, alreadyDeleted: 0, unavailable: false, errors: [] };
  }
  const completedRows = store.db
    .prepare(
      `SELECT payload_json FROM outbox
       WHERE project_id=? AND backend='memorix' AND action='remember'
         AND completed_at IS NOT NULL`,
    )
    .all(project.id) as Array<{ payload_json: string }>;
  const records = [
    ...new Map(
      completedRows.flatMap((row) => {
        try {
          const record = JSON.parse(row.payload_json) as EvidenceRecord;
          return [[record.id, record] as const];
        } catch {
          return [];
        }
      }),
    ).values(),
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

  const databasePath = join(store.paths.backendDir, "memorix", "memorix.db");
  if (!existsSync(databasePath)) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: ["Memorix-compatible database is missing; canonical CAMP data was not purged"],
    };
  }
  let database: Database.Database;
  try {
    database = openMemorixDatabase(store);
  } catch (error) {
    return {
      deleted: 0,
      alreadyDeleted: 0,
      unavailable: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const projectKey = memorixProjectId(project);
  try {
    const observations = database
      .prepare("SELECT id, title, narrative, status FROM observations WHERE projectId=?")
      .all(projectKey) as MemorixObservationRow[];
    const receipts = new Map(
      initialReceipts.map((receipt) => [receipt.recordId, receipt]),
    );
    let alreadyDeleted = initialReceipts.filter(
      (receipt) => receipt.state === "deleted",
    ).length;
    const pendingPairs: Array<{
      record: EvidenceRecord;
      observation: MemorixObservationRow;
    }> = [];
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
        return {
          deleted: 0,
          alreadyDeleted,
          unavailable: false,
          errors: ["Refused purge because a pending Memorix receipt no longer matches its CAMP record"],
        };
      }
      pendingPairs.push({ record, observation });
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
    const ids = pairs.map((pair) => pair.observation.id);
    const placeholders = ids.map(() => "?").join(",");
    database
      .prepare(
        `UPDATE observations SET status='archived', updatedAt=?
         WHERE projectId=? AND id IN (${placeholders})`,
      )
      .run(new Date().toISOString(), projectKey, ...ids);
    const archived = database
      .prepare(
        `SELECT count(*) AS count FROM observations
         WHERE projectId=? AND id IN (${placeholders}) AND status='archived'`,
      )
      .get(projectKey, ...ids) as { count: number };
    if (Number(archived.count) !== pairs.length) {
      return {
        deleted: 0,
        alreadyDeleted,
        unavailable: false,
        errors: ["Memorix archival verification count did not match; canonical CAMP data was not purged"],
      };
    }
    const deleted = database.transaction(() => {
      database
        .prepare(
          `DELETE FROM observation_code_refs WHERE projectId=? AND observationId IN (${placeholders})`,
        )
        .run(projectKey, ...ids);
      return database
        .prepare(
          `DELETE FROM observations
           WHERE projectId=? AND status='archived' AND id IN (${placeholders})`,
        )
        .run(projectKey, ...ids).changes;
    })();
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
  } finally {
    database.close();
    ensurePrivateFile(databasePath);
  }
}
