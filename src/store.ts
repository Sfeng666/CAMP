import Database from "better-sqlite3";
import { gzipSync } from "node:zlib";
import { basename, isAbsolute, join, resolve } from "node:path";
import { chmodSync, existsSync, statSync } from "node:fs";
import type {
  AgentSource,
  CanonicalSession,
  EvidenceKind,
  EvidenceRecord,
  EvidenceState,
  HandoffInput,
  ProjectRegistration,
  SearchHit,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { InspectedProject } from "./git.js";
import { currentCommit, worktreeFingerprint } from "./git.js";
import { getCampPaths, ensureCampDirectories, ensurePrivateDirectory } from "./paths.js";
import { automaticMemoryExclusion, containsLikelySecret, redactForRecall } from "./redaction.js";
import { atomicWrite, fileFingerprint, isInsidePath, newId, nowIso, sha256, stableId } from "./utils.js";

type SqliteDatabase = InstanceType<typeof Database>;

interface ProjectRow {
  id: string;
  kind: "git" | "workspace";
  root_path: string;
  filesystem_id: string;
  git_root: string | null;
  git_common_dir: string | null;
  root_commit: string | null;
  remotes_json: string;
  chatcrystal_key: string;
  memorix_key: string | null;
  migration_state: ProjectRegistration["migrationState"];
  created_at: string;
  updated_at: string;
  active: number;
}

interface EvidenceRow {
  id: string;
  project_id: string;
  kind: EvidenceKind;
  state: EvidenceState;
  title: string;
  content: string;
  confidence: number;
  source_agent: EvidenceRecord["sourceAgent"];
  source_session_id: string | null;
  source_uri: string | null;
  relevant_files_json: string;
  file_fingerprints_json: string;
  commit_sha: string | null;
  worktree_fingerprint: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface StoreSessionResult {
  sessionId: string;
  status: "imported" | "replaced" | "skipped";
  archivePath: string;
}

export interface ProjectStatus {
  project: ProjectRegistration;
  sessions: number;
  messages: number;
  evidence: number;
  quarantined: number;
  bySource: Record<string, number>;
  lastImportedAt: string | null;
  latestHandoffAt: string | null;
  semanticDocuments: number;
  health: Array<{
    component: string;
    status: "ok" | "degraded";
    detail: string;
    checkedAt: string;
  }>;
}

export interface SemanticCandidate {
  layer: "raw" | "curated";
  id: string;
  content: string;
  contentHash: string;
}

export interface SemanticVectorRow {
  layer: "raw" | "curated";
  documentId: string;
  vector: number[];
}

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ftsExpression(query: string): string | null {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_./:-]+/gu)
    ?.filter((token) => token.length > 1)
    .slice(0, 16);
  if (!tokens?.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export class CampStore {
  readonly db: SqliteDatabase;
  readonly paths = ensureCampDirectories(getCampPaths());
  readonly databasePath: string;

  constructor(databasePath = getCampPaths().database) {
    this.databasePath = resolve(databasePath);
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.enforcePrivateDatabaseFiles();
  }

  close(): void {
    this.enforcePrivateDatabaseFiles();
    this.db.close();
    this.enforcePrivateDatabaseFiles();
  }

  private enforcePrivateDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best effort on filesystems that do not expose POSIX permissions.
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('git', 'workspace')),
        root_path TEXT NOT NULL,
        filesystem_id TEXT NOT NULL,
        git_root TEXT,
        git_common_dir TEXT,
        root_commit TEXT,
        remotes_json TEXT NOT NULL DEFAULT '[]',
        chatcrystal_key TEXT NOT NULL,
        memorix_key TEXT,
        migration_state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_aliases (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(kind, value)
      );
      CREATE INDEX IF NOT EXISTS project_alias_project_idx ON project_aliases(project_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        native_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        cwd TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        archive_path TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        imported_at TEXT NOT NULL,
        UNIQUE(project_id, source, native_id)
      );
      CREATE INDEX IF NOT EXISTS session_project_idx ON sessions(project_id, imported_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        native_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tool_name TEXT,
        parent_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(session_id, native_id)
      );
      CREATE INDEX IF NOT EXISTS message_project_idx ON messages(project_id, timestamp DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_agent TEXT NOT NULL,
        source_session_id TEXT,
        source_uri TEXT,
        relevant_files_json TEXT NOT NULL DEFAULT '[]',
        file_fingerprints_json TEXT NOT NULL DEFAULT '{}',
        commit_sha TEXT,
        worktree_fingerprint TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_project_idx ON evidence(project_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS evidence_dedupe_idx
        ON evidence(project_id, kind, content_hash, state);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
        title,
        content,
        content='evidence',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS evidence_ai AFTER INSERT ON evidence BEGIN
        INSERT INTO evidence_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_ad AFTER DELETE ON evidence BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_au AFTER UPDATE ON evidence BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO evidence_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS handoff_project_idx ON handoffs(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS quarantine (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        native_id TEXT,
        reason TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_project_id TEXT REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS quarantine_project_idx ON quarantine(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, source, key)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        action TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS backend_purge_receipts (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        record_id TEXT NOT NULL,
        backend_record_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'deleted')),
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY(project_id, backend, record_id)
      );
      CREATE TABLE IF NOT EXISTS migration_audits (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        state TEXT NOT NULL,
        expected_count INTEGER NOT NULL,
        completed_count INTEGER NOT NULL DEFAULT 0,
        manifest_hash TEXT NOT NULL,
        started_at TEXT NOT NULL,
        verified_at TEXT,
        last_error TEXT,
        PRIMARY KEY(project_id, backend)
      );

      CREATE TABLE IF NOT EXISTS semantic_documents (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        layer TEXT NOT NULL CHECK(layer IN ('raw', 'curated')),
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        model_digest TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, layer, document_id)
      );
      CREATE INDEX IF NOT EXISTS semantic_project_idx
        ON semantic_documents(project_id, model_digest, layer);

      CREATE TABLE IF NOT EXISTS component_health (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        component TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'degraded')),
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY(project_id, component)
      );
    `);
    const evidenceColumns = this.db.prepare("PRAGMA table_info(evidence)").all() as Array<{ name: string }>;
    if (!evidenceColumns.some((column) => column.name === "file_fingerprints_json")) {
      this.db.exec("ALTER TABLE evidence ADD COLUMN file_fingerprints_json TEXT NOT NULL DEFAULT '{}'");
    }
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "content_hash")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
      const rows = this.db.prepare("SELECT id, content FROM messages").all() as Array<{
        id: string;
        content: string;
      }>;
      const update = this.db.prepare("UPDATE messages SET content_hash=? WHERE id=?");
      const backfill = this.db.transaction(() => {
        for (const row of rows) update.run(sha256(row.content), row.id);
      });
      backfill();
    }
    const outboxColumns = this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === "dedupe_key")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN dedupe_key TEXT");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_idx ON outbox(dedupe_key)");
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  registerProject(inspected: InspectedProject): ProjectRegistration {
    const strongAliases = inspected.aliases.filter((alias) => alias.confidence >= 0.9);
    const matched = new Set<string>();
    const findAlias = this.db.prepare(
      "SELECT project_id FROM project_aliases WHERE kind = ? AND value = ?",
    );
    for (const alias of strongAliases) {
      const row = findAlias.get(alias.kind, alias.value) as { project_id: string } | undefined;
      if (row) matched.add(row.project_id);
    }
    if (matched.size > 1) {
      throw new Error(`Project identity is ambiguous across registrations: ${[...matched].join(", ")}`);
    }

    const now = nowIso();
    const id = [...matched][0] ?? newId();
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    const migrationState: ProjectRegistration["migrationState"] =
      inspected.kind === "git" &&
      (existing?.migration_state === "pending-memorix" || existing?.migration_state === "migrated")
        ? existing.migration_state
        : existing?.kind === "workspace" && inspected.kind === "git"
          ? "pending-memorix"
          : inspected.kind === "git"
            ? "native"
            : "fallback";

    const write = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO projects (
            id, kind, root_path, filesystem_id, git_root, git_common_dir,
            root_commit, remotes_json, chatcrystal_key, memorix_key,
            migration_state, active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind=excluded.kind,
            root_path=excluded.root_path,
            filesystem_id=excluded.filesystem_id,
            git_root=excluded.git_root,
            git_common_dir=excluded.git_common_dir,
            root_commit=excluded.root_commit,
            remotes_json=excluded.remotes_json,
            chatcrystal_key=excluded.chatcrystal_key,
            memorix_key=excluded.memorix_key,
            migration_state=excluded.migration_state,
            active=1,
            updated_at=excluded.updated_at
        `)
        .run(
          id,
          inspected.kind,
          inspected.rootPath,
          inspected.filesystemId,
          inspected.gitRoot,
          inspected.gitCommonDir,
          inspected.rootCommit,
          JSON.stringify(inspected.remotes),
          inspected.chatcrystalKey,
          inspected.memorixKey,
          migrationState,
          existing?.created_at ?? now,
          now,
        );

      const insertAlias = this.db.prepare(`
        INSERT INTO project_aliases(project_id, kind, value, confidence, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, value) DO UPDATE SET
          project_id=excluded.project_id,
          confidence=max(project_aliases.confidence, excluded.confidence)
      `);
      for (const alias of inspected.aliases) {
        insertAlias.run(id, alias.kind, alias.value, alias.confidence, now);
      }
    });
    write();
    this.exportRegistry();
    return this.getProject(id) as ProjectRegistration;
  }

  getProject(id: string): ProjectRegistration | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? AND active=1").get(id) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  findProjectByAlias(kind: string, value: string): ProjectRegistration | null {
    const row = this.db
      .prepare(`
        SELECT p.* FROM projects p
        JOIN project_aliases a ON a.project_id = p.id
        WHERE a.kind = ? AND a.value = ? AND p.active=1
        LIMIT 1
      `)
      .get(kind, value) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  listProjects(): ProjectRegistration[] {
    const rows = this.db.prepare("SELECT * FROM projects WHERE active=1 ORDER BY updated_at DESC").all() as ProjectRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  private projectFromRow(row: ProjectRow): ProjectRegistration {
    const aliases = this.db
      .prepare("SELECT kind, value, confidence FROM project_aliases WHERE project_id = ? ORDER BY confidence DESC")
      .all(row.id) as ProjectRegistration["aliases"];
    const sourceRows = this.db
      .prepare("SELECT source, count(*) AS sessions, max(imported_at) AS last_imported_at FROM sessions WHERE project_id=? GROUP BY source")
      .all(row.id) as Array<{ source: AgentSource; sessions: number; last_imported_at: string | null }>;
    const activePaths = [
      row.root_path,
      ...aliases.filter((alias) => alias.kind === "path").map((alias) => alias.value),
    ].filter((value, index, values) => values.indexOf(value) === index);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      kind: row.kind,
      rootPath: row.root_path,
      activePaths,
      filesystemId: row.filesystem_id,
      gitRoot: row.git_root,
      gitCommonDir: row.git_common_dir,
      rootCommit: row.root_commit,
      remotes: json<string[]>(row.remotes_json, []),
      chatcrystalKey: row.chatcrystal_key,
      memorixKey: row.memorix_key,
      sourceCoverage: Object.fromEntries(
        sourceRows.map((source) => [
          source.source,
          { sessions: Number(source.sessions), lastImportedAt: source.last_imported_at },
        ]),
      ),
      aliases,
      migrationState: row.migration_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  exportRegistry(): void {
    const projects = this.listProjects();
    atomicWrite(
      this.paths.registryExport,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects }, null, 2)}\n`,
    );
  }

  storeSession(session: CanonicalSession): StoreSessionResult {
    const contentHash = sha256(
      JSON.stringify({ messages: session.messages, attachments: session.attachments ?? [] }),
    );
    const sessionId = stableId(session.projectId, session.source, session.nativeId);
    const existing = this.db
      .prepare("SELECT content_hash, archive_path FROM sessions WHERE id = ?")
      .get(sessionId) as { content_hash: string; archive_path: string } | undefined;
    if (existing?.content_hash === contentHash) {
      this.db
        .prepare("UPDATE sessions SET source_path=?, source_fingerprint=?, imported_at=? WHERE id=?")
        .run(session.sourcePath, session.sourceFingerprint, nowIso(), sessionId);
      return { sessionId, status: "skipped", archivePath: existing.archive_path };
    }

    const archiveRoot = join(this.paths.archiveDir, session.projectId, session.source);
    ensurePrivateDirectory(archiveRoot);
    const archivePath = join(archiveRoot, `${contentHash}.json.gz`);
    atomicWrite(archivePath, gzipSync(Buffer.from(JSON.stringify(session), "utf8")));
    const importedAt = nowIso();
    const status: StoreSessionResult["status"] = existing ? "replaced" : "imported";

    const write = this.db.transaction(() => {
      if (existing) this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      this.db
        .prepare(`
          INSERT INTO sessions (
            id, project_id, source, native_id, source_path, source_fingerprint,
            content_hash, cwd, started_at, ended_at, message_count, archive_path,
            metadata_json, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_path=excluded.source_path,
            source_fingerprint=excluded.source_fingerprint,
            content_hash=excluded.content_hash,
            cwd=excluded.cwd,
            started_at=excluded.started_at,
            ended_at=excluded.ended_at,
            message_count=excluded.message_count,
            archive_path=excluded.archive_path,
            metadata_json=excluded.metadata_json,
            imported_at=excluded.imported_at
        `)
        .run(
          sessionId,
          session.projectId,
          session.source,
          session.nativeId,
          session.sourcePath,
          session.sourceFingerprint,
          contentHash,
          session.cwd,
          session.startedAt,
          session.endedAt,
          session.messages.length,
          archivePath,
          JSON.stringify({
            __campSession: 1,
            metadata: session.metadata ?? {},
            surface: session.surface,
            sourceVersion: session.sourceVersion ?? null,
            attachments: session.attachments ?? [],
            ingestionCheckpoint: session.ingestionCheckpoint ?? null,
          }),
          importedAt,
        );
      const insert = this.db.prepare(`
        INSERT INTO messages (
          id, session_id, project_id, source, native_id, sequence, role, kind,
          content, content_hash, timestamp, tool_name, parent_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of session.messages) {
        insert.run(
          stableId(sessionId, message.id),
          sessionId,
          session.projectId,
          session.source,
          message.id,
          message.sequence,
          message.role,
          message.kind,
          message.content,
          sha256(message.content),
          message.timestamp,
          message.toolName ?? null,
          message.parentId ?? null,
          JSON.stringify(message.metadata ?? {}),
        );
      }
    });
    write();
    return { sessionId, status, archivePath };
  }

  getSession(sessionId: string, projectId?: string): CanonicalSession | null {
    const session = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ? ${projectId ? "AND project_id = ?" : ""}`)
      .get(...(projectId ? [sessionId, projectId] : [sessionId])) as Record<string, unknown> | undefined;
    if (!session) return null;
    const project = this.getProject(String(session.project_id));
    if (!project) return null;
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as Array<Record<string, unknown>>;
    const storedMetadata = json<Record<string, unknown>>(String(session.metadata_json), {});
    const campEnvelope = storedMetadata.__campSession === 1;
    const attachments = campEnvelope && Array.isArray(storedMetadata.attachments)
      ? (storedMetadata.attachments as NonNullable<CanonicalSession["attachments"]>)
      : [];
    const ingestionCheckpoint =
      campEnvelope &&
      storedMetadata.ingestionCheckpoint &&
      typeof storedMetadata.ingestionCheckpoint === "object"
        ? (storedMetadata.ingestionCheckpoint as NonNullable<CanonicalSession["ingestionCheckpoint"]>)
        : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: String(session.source) as AgentSource,
      surface: campEnvelope && typeof storedMetadata.surface === "string"
        ? (storedMetadata.surface as CanonicalSession["surface"])
        : "unknown",
      ...(campEnvelope && typeof storedMetadata.sourceVersion === "string"
        ? { sourceVersion: storedMetadata.sourceVersion }
        : {}),
      nativeId: String(session.native_id),
      projectId: String(session.project_id),
      projectRoot: project.rootPath,
      cwd: session.cwd ? String(session.cwd) : null,
      sourcePath: String(session.source_path),
      sourceFingerprint: String(session.source_fingerprint),
      startedAt: String(session.started_at),
      endedAt: String(session.ended_at),
      messages: rows.map((row) => ({
        id: String(row.native_id),
        sequence: Number(row.sequence),
        role: String(row.role) as CanonicalSession["messages"][number]["role"],
        kind: String(row.kind) as CanonicalSession["messages"][number]["kind"],
        content: String(row.content),
        timestamp: String(row.timestamp),
        ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
        ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
        metadata: json<Record<string, unknown>>(String(row.metadata_json), {}),
      })),
      ...(attachments.length ? { attachments } : {}),
      ...(ingestionCheckpoint ? { ingestionCheckpoint } : {}),
      metadata: campEnvelope
        ? ((storedMetadata.metadata as Record<string, unknown> | undefined) ?? {})
        : storedMetadata,
    };
  }

  listSessionIds(projectId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM sessions WHERE project_id=? ORDER BY imported_at")
      .all(projectId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  latestSession(projectId: string): { id: string; session: CanonicalSession } | null {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE project_id=? ORDER BY ended_at DESC, imported_at DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    if (!row) return null;
    const session = this.getSession(row.id, projectId);
    return session ? { id: row.id, session } : null;
  }

  private fingerprintFiles(
    projectId: string,
    relevantFiles: string[],
  ): Record<string, string | null> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return Object.fromEntries(
      relevantFiles.map((path) => {
        const absolute = isAbsolute(path) ? resolve(path) : resolve(project.rootPath, path);
        if (!isInsidePath(absolute, project.rootPath) || !existsSync(absolute)) return [path, null];
        try {
          return [path, fileFingerprint(absolute)];
        } catch {
          return [path, null];
        }
      }),
    );
  }

  putEvidence(input: Omit<EvidenceRecord, "schemaVersion" | "id" | "contentHash" | "fileFingerprints" | "createdAt" | "updatedAt"> & { id?: string }): EvidenceRecord {
    if (containsLikelySecret(`${input.title}\n${input.content}`)) {
      throw new Error("Curated memory appears to contain a credential or secret; raw history remains available locally");
    }
    const exclusion = automaticMemoryExclusion(`${input.title}\n${input.content}`);
    if (input.sourceAgent !== "user" && exclusion) {
      throw new Error(`${exclusion}; store only the process constraint or verified source reference`);
    }
    const contentHash = sha256(`${input.title}\n${input.content}`);
    const existing = this.db
      .prepare("SELECT * FROM evidence WHERE project_id=? AND kind=? AND content_hash=? AND state=?")
      .get(input.projectId, input.kind, contentHash, input.state) as EvidenceRow | undefined;
    if (existing) return this.evidenceFromRow(existing);
    const now = nowIso();
    const id = input.id ?? newId();
    const fileFingerprints = this.fingerprintFiles(input.projectId, input.relevantFiles);
    this.db
      .prepare(`
        INSERT INTO evidence (
          id, project_id, kind, state, title, content, confidence, source_agent,
          source_session_id, source_uri, relevant_files_json, commit_sha,
          file_fingerprints_json, worktree_fingerprint, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.projectId,
        input.kind,
        input.state,
        input.title,
        input.content,
        input.confidence,
        input.sourceAgent,
        input.sourceSessionId,
        input.sourceUri,
        JSON.stringify(input.relevantFiles),
        input.commit,
        JSON.stringify(fileFingerprints),
        input.worktreeFingerprint,
        contentHash,
        now,
        now,
      );
    return this.getEvidence(id) as EvidenceRecord;
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
    return row ? this.evidenceFromRow(row) : null;
  }

  listEvidence(projectId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE project_id=? ORDER BY created_at, id")
      .all(projectId) as EvidenceRow[];
    return rows.map((row) => this.evidenceFromRow(row));
  }

  private evidenceFromRow(row: EvidenceRow): EvidenceRecord {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      state: row.state,
      title: row.title,
      content: row.content,
      confidence: row.confidence,
      sourceAgent: row.source_agent,
      sourceSessionId: row.source_session_id,
      sourceUri: row.source_uri,
      relevantFiles: json<string[]>(row.relevant_files_json, []),
      fileFingerprints: json<Record<string, string | null>>(row.file_fingerprints_json, {}),
      commit: row.commit_sha,
      worktreeFingerprint: row.worktree_fingerprint,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createHandoff(project: ProjectRegistration, input: HandoffInput): EvidenceRecord {
    const sections: Array<[string, string[]]> = [
      ["Completed", input.completed],
      ["Changed paths", input.changedPaths],
      ["Validation", input.validations],
      ["Unresolved", input.unresolved],
      ["Next steps", input.nextSteps],
      ["Source sessions", input.sourceSessions],
    ];
    const content = [
      `Goal: ${input.goal}`,
      ...sections.flatMap(([title, values]) =>
        values.length ? [`\n${title}:`, ...values.map((value) => `- ${value}`)] : [],
      ),
    ].join("\n");
    const evidence = this.putEvidence({
      projectId: project.id,
      kind: "handoff",
      state: "candidate",
      title: `Current handoff: ${input.goal.slice(0, 100)}`,
      content,
      confidence: 0.8,
      sourceAgent: "camp",
      sourceSessionId: input.sourceSessions[0] ?? null,
      sourceUri: input.sourceSessions[0] ? `camp://project/${project.id}/conversation/${input.sourceSessions[0]}` : null,
      relevantFiles: input.changedPaths,
      commit: currentCommit(project.rootPath),
      worktreeFingerprint: worktreeFingerprint(project.rootPath),
    });
    this.db
      .prepare("INSERT INTO handoffs(id, project_id, evidence_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId(), project.id, evidence.id, JSON.stringify(input), nowIso());
    return evidence;
  }

  latestHandoff(projectId: string): EvidenceRecord | null {
    const row = this.db
      .prepare(`
        SELECT e.* FROM handoffs h
        JOIN evidence e ON e.id = h.evidence_id
        WHERE h.project_id = ?
        ORDER BY h.created_at DESC LIMIT 1
      `)
      .get(projectId) as EvidenceRow | undefined;
    return row ? this.evidenceFromRow(row) : null;
  }

  latestHandoffPayload(projectId: string): HandoffInput | null {
    const row = this.db
      .prepare("SELECT payload_json FROM handoffs WHERE project_id=? ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as { payload_json: string } | undefined;
    return row ? json<HandoffInput | null>(row.payload_json, null) : null;
  }

  refreshStaleness(projectId: string): number {
    const project = this.getProject(projectId);
    if (!project) return 0;
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE project_id=? AND state IN ('candidate', 'verified')")
      .all(projectId) as EvidenceRow[];
    const commit = currentCommit(project.rootPath);
    const worktree = worktreeFingerprint(project.rootPath);
    const staleIds: string[] = [];
    for (const row of rows) {
      const files = json<string[]>(row.relevant_files_json, []);
      const recorded = json<Record<string, string | null>>(row.file_fingerprints_json, {});
      const current = this.fingerprintFiles(projectId, files);
      const fileChanged = files.some((path) => (recorded[path] ?? null) !== (current[path] ?? null));
      const stateSensitive = new Set<EvidenceKind>(["progress", "verification", "handoff"]).has(row.kind);
      const gitChanged =
        stateSensitive &&
        ((row.commit_sha !== null && row.commit_sha !== commit) ||
          (row.worktree_fingerprint !== null && row.worktree_fingerprint !== worktree));
      if (fileChanged || gitChanged) staleIds.push(row.id);
    }
    if (!staleIds.length) return 0;
    const update = this.db.prepare("UPDATE evidence SET state='stale', updated_at=? WHERE id=?");
    const transaction = this.db.transaction(() => {
      const now = nowIso();
      for (const id of staleIds) update.run(now, id);
    });
    transaction();
    return staleIds.length;
  }

  search(projectId: string, query: string, source: "raw" | "curated" | "all" = "all", limit = 20): SearchHit[] {
    const expression = ftsExpression(query);
    const hits: SearchHit[] = [];
    if ((source === "raw" || source === "all") && expression) {
      const rows = this.db
        .prepare(`
          SELECT m.id, m.session_id, m.project_id, m.source, m.role, m.content,
                 m.timestamp, bm25(messages_fts) AS rank
          FROM messages_fts
          JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ? AND m.project_id = ?
          ORDER BY rank LIMIT ?
        `)
        .all(expression, projectId, limit) as Array<Record<string, unknown>>;
      hits.push(
        ...rows.map((row) => ({
          layer: "raw" as const,
          id: String(row.id),
          projectId: String(row.project_id),
          source: String(row.source),
          title: `${String(row.source)} ${String(row.role)} message`,
          content: redactForRecall(String(row.content)),
          timestamp: String(row.timestamp),
          score: -Number(row.rank),
          uri: `camp://project/${String(row.project_id)}/conversation/${String(row.session_id)}#message=${String(row.id)}`,
        })),
      );
    }
    if ((source === "curated" || source === "all") && expression) {
      const rows = this.db
        .prepare(`
          SELECT e.*, bm25(evidence_fts) AS rank
          FROM evidence_fts
          JOIN evidence e ON e.rowid = evidence_fts.rowid
          WHERE evidence_fts MATCH ? AND e.project_id = ?
            AND e.state NOT IN ('superseded', 'quarantined')
          ORDER BY rank LIMIT ?
        `)
        .all(expression, projectId, limit) as Array<EvidenceRow & { rank: number }>;
      hits.push(
        ...rows.map((row) => ({
          layer: "curated" as const,
          id: row.id,
          projectId: row.project_id,
          source: row.source_agent,
          title: row.title,
          content: redactForRecall(row.content),
          timestamp: row.updated_at,
          score: -Number(row.rank),
          uri: row.source_uri ?? `camp://project/${row.project_id}/memory/${row.id}`,
          state: row.state,
        })),
      );
    }
    return hits.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }

  semanticCandidates(
    projectId: string,
    modelDigest: string,
    limit = 32,
  ): SemanticCandidate[] {
    // Curated handoffs and decisions must become semantic-searchable promptly;
    // otherwise a large raw archive can starve them for many polling cycles.
    const curatedBudget = Math.min(limit, Math.max(1, Math.min(8, Math.ceil(limit / 4))));
    const curatedRows = this.db
      .prepare(`
        SELECT 'curated' AS layer, e.id, e.title || '\n' || e.content AS content,
               e.content_hash
        FROM evidence e
        LEFT JOIN semantic_documents s
          ON s.project_id=e.project_id AND s.layer='curated' AND s.document_id=e.id
        WHERE e.project_id=? AND e.state NOT IN ('superseded', 'quarantined')
          AND (
            s.document_id IS NULL OR s.model_digest<>? OR s.content_hash<>e.content_hash
          )
        ORDER BY e.updated_at DESC LIMIT ?
      `)
      .all(projectId, modelDigest, curatedBudget) as Array<{
      layer: "curated";
      id: string;
      content: string;
      content_hash: string;
    }>;
    const rawBudget = Math.max(0, limit - curatedRows.length);
    const rawRows = this.db
      .prepare(`
        SELECT 'raw' AS layer, m.id, m.content, m.content_hash
        FROM messages m
        LEFT JOIN semantic_documents s
          ON s.project_id=m.project_id AND s.layer='raw' AND s.document_id=m.id
        WHERE m.project_id=? AND (
          s.document_id IS NULL OR s.model_digest<>? OR s.content_hash<>m.content_hash
        )
        ORDER BY m.timestamp DESC LIMIT ?
      `)
      .all(projectId, modelDigest, rawBudget) as Array<{
      layer: "raw";
      id: string;
      content: string;
      content_hash: string;
    }>;
    return [...curatedRows, ...rawRows].map((row) => ({
      layer: row.layer,
      id: row.id,
      content: row.content,
      contentHash: row.content_hash || sha256(row.content),
    }));
  }

  putSemanticVector(input: {
    projectId: string;
    layer: "raw" | "curated";
    documentId: string;
    contentHash: string;
    model: string;
    modelDigest: string;
    vector: number[];
  }): void {
    this.db
      .prepare(`
        INSERT INTO semantic_documents(
          project_id, layer, document_id, content_hash, model,
          model_digest, vector_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, layer, document_id) DO UPDATE SET
          content_hash=excluded.content_hash,
          model=excluded.model,
          model_digest=excluded.model_digest,
          vector_json=excluded.vector_json,
          updated_at=excluded.updated_at
      `)
      .run(
        input.projectId,
        input.layer,
        input.documentId,
        input.contentHash,
        input.model,
        input.modelDigest,
        JSON.stringify(input.vector),
        nowIso(),
      );
  }

  *semanticVectors(
    projectId: string,
    modelDigest: string,
    source: "raw" | "curated" | "all" = "all",
  ): Iterable<SemanticVectorRow> {
    const rows = this.db
      .prepare(`
        SELECT layer, document_id, vector_json FROM semantic_documents
        WHERE project_id=? AND model_digest=? ${source === "all" ? "" : "AND layer=?"}
      `)
      .iterate(...(source === "all" ? [projectId, modelDigest] : [projectId, modelDigest, source])) as Iterable<{
      layer: "raw" | "curated";
      document_id: string;
      vector_json: string;
    }>;
    for (const row of rows) {
      const vector = json<number[]>(row.vector_json, []);
      if (vector.length) yield { layer: row.layer, documentId: row.document_id, vector };
    }
  }

  searchHitByDocument(
    projectId: string,
    layer: "raw" | "curated",
    id: string,
    score: number,
  ): SearchHit | null {
    if (layer === "raw") {
      const row = this.db
        .prepare("SELECT * FROM messages WHERE project_id=? AND id=?")
        .get(projectId, id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        layer,
        id,
        projectId,
        source: String(row.source),
        title: `${String(row.source)} ${String(row.role)} message`,
        content: redactForRecall(String(row.content)),
        timestamp: String(row.timestamp),
        score,
        uri: `camp://project/${projectId}/conversation/${String(row.session_id)}#message=${id}`,
      };
    }
    const row = this.db
      .prepare("SELECT * FROM evidence WHERE project_id=? AND id=? AND state NOT IN ('superseded', 'quarantined')")
      .get(projectId, id) as EvidenceRow | undefined;
    if (!row) return null;
    return {
      layer,
      id,
      projectId,
      source: row.source_agent,
      title: row.title,
      content: redactForRecall(row.content),
      timestamp: row.updated_at,
      score,
      uri: row.source_uri ?? `camp://project/${projectId}/memory/${id}`,
      state: row.state,
    };
  }

  addQuarantine(input: {
    projectId?: string | null;
    source: AgentSource;
    sourcePath: string;
    nativeId?: string | null;
    reason: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = stableId(input.source, input.sourcePath, input.nativeId, input.reason);
    this.db
      .prepare(`
        INSERT INTO quarantine(id, project_id, source, source_path, native_id, reason, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json
      `)
      .run(
        id,
        input.projectId ?? null,
        input.source,
        input.sourcePath,
        input.nativeId ?? null,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      );
    return id;
  }

  listQuarantine(projectId?: string): Array<Record<string, unknown>> {
    const sql = `SELECT * FROM quarantine WHERE resolved_at IS NULL ${projectId ? "AND project_id = ?" : ""} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
  }

  resolveQuarantine(id: string, projectId: string): boolean {
    const result = this.db
      .prepare("UPDATE quarantine SET resolved_at=?, resolved_project_id=? WHERE id=? AND resolved_at IS NULL")
      .run(nowIso(), projectId, id);
    return result.changes > 0;
  }

  isSourceAssigned(
    source: AgentSource,
    sourcePath: string,
    nativeId: string | null,
    projectId: string,
  ): boolean {
    const row = this.db
      .prepare(`
        SELECT 1 AS assigned FROM quarantine
        WHERE source=? AND source_path=? AND coalesce(native_id, '')=coalesce(?, '')
          AND resolved_at IS NOT NULL AND resolved_project_id=?
        LIMIT 1
      `)
      .get(source, sourcePath, nativeId, projectId) as { assigned: number } | undefined;
    return Boolean(row);
  }

  checkpoint(projectId: string, source: AgentSource, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM checkpoints WHERE project_id=? AND source=? AND key=?")
      .get(projectId, source, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCheckpoint(projectId: string, source: AgentSource, key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO checkpoints(project_id, source, key, value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, source, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `)
      .run(projectId, source, key, value, nowIso());
  }

  enqueue(
    projectId: string,
    backend: string,
    action: string,
    payload: unknown,
    dedupeKey?: string,
  ): string {
    if (dedupeKey) {
      const existing = this.db
        .prepare("SELECT id FROM outbox WHERE dedupe_key=?")
        .get(dedupeKey) as { id: string } | undefined;
      if (existing) return existing.id;
    }
    const id = newId();
    this.db
      .prepare("INSERT INTO outbox(id, project_id, backend, action, dedupe_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, backend, action, dedupeKey ?? null, JSON.stringify(payload), nowIso());
    return id;
  }

  pendingOutbox(backend?: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM outbox WHERE completed_at IS NULL ${backend ? "AND backend=?" : ""} ORDER BY created_at`)
      .all(...(backend ? [backend] : [])) as Array<Record<string, unknown>>;
  }

  completeOutbox(id: string): void {
    this.db.prepare("UPDATE outbox SET completed_at=?, last_error=NULL WHERE id=?").run(nowIso(), id);
  }

  failOutbox(id: string, error: string): void {
    this.db.prepare("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?").run(error, id);
  }

  backendPurgeReceipts(
    projectId: string,
    backend: string,
  ): Array<{ recordId: string; backendRecordId: string; state: "pending" | "deleted" }> {
    const rows = this.db
      .prepare(`
        SELECT record_id, backend_record_id, state
        FROM backend_purge_receipts WHERE project_id=? AND backend=?
      `)
      .all(projectId, backend) as Array<{
      record_id: string;
      backend_record_id: string;
      state: "pending" | "deleted";
    }>;
    return rows.map((row) => ({
      recordId: row.record_id,
      backendRecordId: row.backend_record_id,
      state: row.state,
    }));
  }

  beginBackendPurgeReceipt(
    projectId: string,
    backend: string,
    recordId: string,
    backendRecordId: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO backend_purge_receipts(
          project_id, backend, record_id, backend_record_id, state, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(project_id, backend, record_id) DO UPDATE SET
          backend_record_id=excluded.backend_record_id
      `)
      .run(projectId, backend, recordId, backendRecordId, nowIso());
  }

  completeBackendPurgeReceipt(projectId: string, backend: string, recordId: string): void {
    this.db
      .prepare(`
        UPDATE backend_purge_receipts SET state='deleted', deleted_at=?
        WHERE project_id=? AND backend=? AND record_id=?
      `)
      .run(nowIso(), projectId, backend, recordId);
  }

  beginMigrationAudit(
    projectId: string,
    backend: string,
    contentHashes: string[],
  ): void {
    const manifestHash = sha256([...contentHashes].sort().join("\n"));
    this.db
      .prepare(`
        INSERT INTO migration_audits(
          project_id, backend, state, expected_count, completed_count,
          manifest_hash, started_at, verified_at, last_error
        ) VALUES (?, ?, 'pending', ?, 0, ?, ?, NULL, NULL)
        ON CONFLICT(project_id, backend) DO UPDATE SET
          state=CASE WHEN migration_audits.state='verified' THEN 'verified' ELSE 'pending' END,
          expected_count=excluded.expected_count,
          manifest_hash=excluded.manifest_hash,
          last_error=NULL
      `)
      .run(projectId, backend, contentHashes.length, manifestHash, nowIso());
  }

  verifyMigration(
    projectId: string,
    backend: string,
    expectedHashes: string[],
    completedHashes: string[],
  ): boolean {
    const expected = [...expectedHashes].sort();
    const completed = [...new Set(completedHashes)].sort();
    const manifestHash = sha256(expected.join("\n"));
    const verified =
      expected.length === completed.length &&
      expected.every((hash, index) => completed[index] === hash);
    this.db
      .prepare(`
        UPDATE migration_audits SET state=?, completed_count=?, manifest_hash=?,
          verified_at=?, last_error=? WHERE project_id=? AND backend=?
      `)
      .run(
        verified ? "verified" : "pending",
        completed.length,
        manifestHash,
        verified ? nowIso() : null,
        verified ? null : "Completed payload hashes do not yet match the fallback manifest",
        projectId,
        backend,
      );
    if (verified) {
      this.db
        .prepare("UPDATE projects SET migration_state='migrated', updated_at=? WHERE id=?")
        .run(nowIso(), projectId);
      this.exportRegistry();
    }
    return verified;
  }

  migrationAudit(projectId: string, backend = "memorix"): Record<string, unknown> | null {
    return (
      (this.db
        .prepare("SELECT * FROM migration_audits WHERE project_id=? AND backend=?")
        .get(projectId, backend) as Record<string, unknown> | undefined) ?? null
    );
  }

  projectStatus(projectId: string): ProjectStatus {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const scalar = (sql: string): number =>
      Number((this.db.prepare(sql).get(projectId) as { count: number }).count);
    const sourceRows = this.db
      .prepare("SELECT source, count(*) AS count FROM sessions WHERE project_id=? GROUP BY source")
      .all(projectId) as Array<{ source: string; count: number }>;
    const last = this.db
      .prepare("SELECT max(imported_at) AS value FROM sessions WHERE project_id=?")
      .get(projectId) as { value: string | null };
    const handoff = this.db
      .prepare("SELECT max(created_at) AS value FROM handoffs WHERE project_id=?")
      .get(projectId) as { value: string | null };
    const health = this.db
      .prepare("SELECT component, status, detail, checked_at FROM component_health WHERE project_id=? ORDER BY component")
      .all(projectId) as Array<{
      component: string;
      status: "ok" | "degraded";
      detail: string;
      checked_at: string;
    }>;
    return {
      project,
      sessions: scalar("SELECT count(*) AS count FROM sessions WHERE project_id=?"),
      messages: scalar("SELECT count(*) AS count FROM messages WHERE project_id=?"),
      evidence: scalar("SELECT count(*) AS count FROM evidence WHERE project_id=?"),
      quarantined: scalar("SELECT count(*) AS count FROM quarantine WHERE project_id=? AND resolved_at IS NULL"),
      bySource: Object.fromEntries(sourceRows.map((row) => [row.source, Number(row.count)])),
      lastImportedAt: last.value,
      latestHandoffAt: handoff.value,
      semanticDocuments: scalar("SELECT count(*) AS count FROM semantic_documents WHERE project_id=?"),
      health: health.map((row) => ({
        component: row.component,
        status: row.status,
        detail: row.detail,
        checkedAt: row.checked_at,
      })),
    };
  }

  recordHealth(
    projectId: string,
    component: string,
    status: "ok" | "degraded",
    detail: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO component_health(project_id, component, status, detail, checked_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, component) DO UPDATE SET
          status=excluded.status, detail=excluded.detail, checked_at=excluded.checked_at
      `)
      .run(projectId, component, status, detail, nowIso());
  }

  unregisterProject(projectId: string, purge: boolean): void {
    if (purge) {
      this.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    } else {
      this.db.prepare("UPDATE projects SET active=0, updated_at=? WHERE id=?").run(nowIso(), projectId);
    }
    this.exportRegistry();
  }

  sourceFileInfo(path: string): { size: number; mtime: string } {
    if (!existsSync(path)) return { size: 0, mtime: nowIso() };
    const stat = statSync(path);
    return { size: stat.size, mtime: stat.mtime.toISOString() };
  }

  rebuildLexicalIndexes(): void {
    this.db.exec(`
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      INSERT INTO evidence_fts(evidence_fts) VALUES ('rebuild');
      INSERT INTO messages_fts(messages_fts) VALUES ('optimize');
      INSERT INTO evidence_fts(evidence_fts) VALUES ('optimize');
    `);
  }
}
