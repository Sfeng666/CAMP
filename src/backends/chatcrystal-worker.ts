import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import type { AgentSource, CanonicalSession, ProjectRegistration } from "../types.js";
import { ensurePrivateFile } from "../paths.js";

// This is CAMP's narrow, local ingest extension for the ChatCrystal 0.5.8
// conversation schema. It deliberately vendors only the content hashing,
// namespacing, and import semantics CAMP uses. The upstream HTTP server,
// source watchers, AI providers, and static-file routes are never installed or
// exposed in a production CAMP package.
type ChatCrystalSource = "claude-code" | "codex" | "cursor" | "trae" | "copilot" | "antigravity";

interface ChatCrystalMessage {
  id: string;
  parentUuid: string | null;
  type: string;
  role: string;
  content: string;
  hasToolUse: boolean;
  hasCode: boolean;
  thinking: string | null;
  timestamp: string;
}

interface ChatCrystalConversation {
  id: string;
  slug: string | null;
  source: ChatCrystalSource;
  projectDir: string;
  projectName: string;
  cwd: string | null;
  gitBranch: string | null;
  messages: ChatCrystalMessage[];
  firstMessageAt: string;
  lastMessageAt: string;
}

interface ImportItem {
  source: ChatCrystalSource;
  sourceConversationId: string;
  conversationId: string;
  contentHash: string;
  parserVersion: string;
  meta: {
    filePath: string;
    fileSize: number;
    fileMtime: string;
  };
  parsed: ChatCrystalConversation;
}

interface ChatCrystalResult {
  total: number;
  imported: number;
  replaced: number;
  skipped: number;
  errors: number;
  errorIds: string[];
  items: Array<Record<string, unknown>>;
}

const gunzipAsync = promisify(gunzip);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  slug TEXT,
  source TEXT NOT NULL DEFAULT 'claude-code',
  source_conversation_id TEXT,
  content_hash TEXT,
  parser_version TEXT,
  project_dir TEXT NOT NULL,
  project_name TEXT NOT NULL,
  cwd TEXT,
  git_branch TEXT,
  message_count INTEGER DEFAULT 0,
  first_message_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  file_mtime TEXT,
  status TEXT DEFAULT 'imported',
  experience_score REAL,
  experience_gate_reason TEXT,
  experience_gate_details TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_uuid TEXT,
  type TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  has_tool_use INTEGER DEFAULT 0,
  has_code INTEGER DEFAULT 0,
  thinking TEXT,
  timestamp TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_conclusions TEXT,
  code_snippets TEXT,
  raw_llm_response TEXT,
  is_edited INTEGER DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending',
  project_key TEXT,
  scope TEXT DEFAULT 'project',
  source_type TEXT DEFAULT 'imported-conversation',
  source_agent TEXT DEFAULT 'unknown',
  task_kind TEXT,
  error_signatures TEXT,
  files_touched TEXT,
  outcome_type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_dir);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source);
CREATE INDEX IF NOT EXISTS idx_conversations_source_conversation_id
  ON conversations(source, source_conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_content_hash ON conversations(content_hash);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
`;

function mappedSource(source: AgentSource): ChatCrystalSource {
  if (source === "claude") return "claude-code";
  if (source === "cursor") return "cursor";
  if (source === "antigravity") return "antigravity";
  return "codex";
}

function namespaceConversationId(source: ChatCrystalSource, sourceConversationId: string): string {
  return sourceConversationId.startsWith(`${source}:`)
    ? sourceConversationId
    : `${source}:${sourceConversationId}`;
}

function contentHash(parsed: ChatCrystalConversation): string {
  const canonical = {
    source: parsed.source,
    messages: parsed.messages.map((message, index) => ({
      index,
      type: message.type,
      role: message.role,
      content: message.content,
      hasToolUse: message.hasToolUse,
      hasCode: message.hasCode,
      thinking: message.thinking,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function importItem(
  session: CanonicalSession,
  project: ProjectRegistration,
  sourceInfo: { size: number; mtime: string },
): ImportItem | null {
  if (session.messages.length < 2) return null;
  const source = mappedSource(session.source);
  const sourceConversationId = `${project.id}:${session.source}:${session.nativeId}`;
  const conversationId = namespaceConversationId(source, sourceConversationId);
  const idMap = new Map(
    session.messages.map((message) => [message.id, `${conversationId}:${message.id}`]),
  );
  const parsed: ChatCrystalConversation = {
    id: conversationId,
    slug: session.messages.find((message) => message.role === "user")?.content.slice(0, 100) ?? null,
    source,
    projectDir: project.rootPath,
    projectName: basename(project.rootPath),
    cwd: session.cwd,
    gitBranch: null,
    messages: session.messages.map((message) => ({
      id: idMap.get(message.id) ?? `${conversationId}:${message.id}`,
      parentUuid: message.parentId
        ? (idMap.get(message.parentId) ?? `${conversationId}:${message.parentId}`)
        : null,
      type: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
      role: message.role,
      content: message.content,
      hasToolUse: message.kind === "tool-call" || message.kind === "tool-result",
      hasCode: message.content.includes("```"),
      thinking: null,
      timestamp: message.timestamp,
    })),
    firstMessageAt: session.startedAt,
    lastMessageAt: session.endedAt,
  };
  return {
    source,
    sourceConversationId,
    conversationId,
    contentHash: contentHash(parsed),
    parserVersion: `camp-${session.source}@1`,
    meta: {
      filePath: session.sourcePath,
      fileSize: sourceInfo.size,
      fileMtime: sourceInfo.mtime,
    },
    parsed,
  };
}

function insertMessages(db: Database.Database, item: ImportItem): void {
  const insert = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, parent_uuid, type, role, content,
      has_tool_use, has_code, thinking, timestamp, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, message] of item.parsed.messages.entries()) {
    insert.run(
      message.id,
      item.conversationId,
      message.parentUuid,
      message.type,
      message.role,
      message.content,
      message.hasToolUse ? 1 : 0,
      message.hasCode ? 1 : 0,
      message.thinking,
      message.timestamp,
      index,
    );
  }
}

function metadataValues(item: ImportItem): unknown[] {
  return [
    item.parsed.slug,
    item.source,
    item.sourceConversationId,
    item.contentHash,
    item.parserVersion,
    item.parsed.projectDir,
    item.parsed.projectName,
    item.parsed.cwd,
    item.parsed.gitBranch,
    item.parsed.messages.length,
    item.parsed.firstMessageAt,
    item.parsed.lastMessageAt,
    item.meta.filePath,
    item.meta.fileSize,
    item.meta.fileMtime,
  ];
}

function ingestOne(db: Database.Database, item: ImportItem): Record<string, unknown> {
  const existing = db.prepare(`
    SELECT id, content_hash FROM conversations
    WHERE source=? AND (source_conversation_id=? OR id=?)
    LIMIT 1
  `).get(item.source, item.sourceConversationId, item.conversationId) as
    | { id: string; content_hash: string | null }
    | undefined;
  if (existing?.content_hash === item.contentHash) {
    db.prepare(`
      UPDATE conversations SET
        slug=?, source=?, source_conversation_id=?, content_hash=?, parser_version=?,
        project_dir=?, project_name=?, cwd=?, git_branch=?, message_count=?,
        first_message_at=?, last_message_at=?, file_path=?, file_size=?, file_mtime=?,
        updated_at=datetime('now')
      WHERE id=?
    `).run(...metadataValues(item), existing.id);
    return {
      source: item.source,
      sourceConversationId: item.sourceConversationId,
      conversationId: existing.id,
      status: "skipped",
    };
  }

  const transaction = db.transaction(() => {
    if (existing) {
      db.prepare(`
        DELETE FROM notes
        WHERE conversation_id=? AND coalesce(is_edited, 0)=0
          AND coalesce(source_type, 'imported-conversation')='imported-conversation'
      `).run(existing.id);
      db.prepare("DELETE FROM messages WHERE conversation_id=?").run(existing.id);
      const hasPreservedNote = Boolean(
        db.prepare("SELECT 1 FROM notes WHERE conversation_id=? LIMIT 1").get(existing.id),
      );
      db.prepare(`
        UPDATE conversations SET
          slug=?, source=?, source_conversation_id=?, content_hash=?, parser_version=?,
          project_dir=?, project_name=?, cwd=?, git_branch=?, message_count=?,
          first_message_at=?, last_message_at=?, file_path=?, file_size=?, file_mtime=?,
          status=?, experience_score=NULL, experience_gate_reason=NULL,
          experience_gate_details=NULL, updated_at=datetime('now')
        WHERE id=?
      `).run(...metadataValues(item), hasPreservedNote ? "summarized" : "imported", existing.id);
      item.conversationId = existing.id;
    } else {
      db.prepare(`
        INSERT INTO conversations (
          id, slug, source, source_conversation_id, content_hash, parser_version,
          project_dir, project_name, cwd, git_branch, message_count,
          first_message_at, last_message_at, file_path, file_size, file_mtime, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')
      `).run(item.conversationId, ...metadataValues(item));
    }
    insertMessages(db, item);
    db.prepare("INSERT INTO import_log(file_path, status, message) VALUES (?, 'success', ?)").run(
      item.meta.filePath,
      `${existing ? "Replaced" : "Imported"} ${item.parsed.messages.length} remote messages`,
    );
  });
  transaction();
  return {
    source: item.source,
    sourceConversationId: item.sourceConversationId,
    conversationId: item.conversationId,
    status: existing ? "replaced" : "imported",
  };
}

function merge(aggregate: ChatCrystalResult, item: Record<string, unknown>): void {
  aggregate.total += 1;
  const status = String(item.status ?? "error");
  if (status === "imported") aggregate.imported += 1;
  else if (status === "replaced") aggregate.replaced += 1;
  else if (status === "skipped") aggregate.skipped += 1;
  else {
    aggregate.errors += 1;
    const id = String(item.conversationId ?? "");
    if (id && aggregate.errorIds.length < 100) aggregate.errorIds.push(id);
  }
  if (aggregate.items.length < 100) aggregate.items.push(item);
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("ChatCrystal worker requires DATA_DIR");
  const databasePath = join(dataDir, "chatcrystal.db");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  try {
    const mode = process.argv[2];
    if (mode === "purge") {
      const projectId = process.argv[3];
      if (!projectId) throw new Error("ChatCrystal purge requires a project UUID");
      const result = db
        .prepare("DELETE FROM conversations WHERE source_conversation_id LIKE ?")
        .run(`${projectId}:%`);
      process.stdout.write(JSON.stringify({ deleted: result.changes }));
      return;
    }
    if (mode !== "ingest") throw new Error(`Unknown ChatCrystal worker mode: ${mode}`);

    const aggregate: ChatCrystalResult = {
      total: 0,
      imported: 0,
      replaced: 0,
      skipped: 0,
      errors: 0,
      errorIds: [],
      items: [],
    };
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as {
        archivePath?: string;
        project: ProjectRegistration;
        sourceInfo: { size: number; mtime: string };
      };
      try {
        if (!value.archivePath) throw new Error("ChatCrystal ingest descriptor is missing an archive path");
        const compressed = await readFile(value.archivePath);
        const session = JSON.parse(
          (await gunzipAsync(compressed)).toString("utf8"),
        ) as CanonicalSession;
        const item = importItem(session, value.project, value.sourceInfo);
        if (item) merge(aggregate, ingestOne(db, item));
      } catch (error) {
        merge(aggregate, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    process.stdout.write(JSON.stringify(aggregate));
  } finally {
    db.close();
    ensurePrivateFile(databasePath);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
