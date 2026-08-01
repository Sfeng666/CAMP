import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import type { AgentSource, CanonicalSession, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../paths.js";

type ChatCrystalSource =
  | "claude-code"
  | "codex"
  | "cursor"
  | "trae"
  | "copilot"
  | "antigravity";

interface ChatCrystalResult {
  total: number;
  imported: number;
  replaced: number;
  skipped: number;
  errors: number;
  errorIds: string[];
}

function mappedSource(source: AgentSource): ChatCrystalSource {
  if (source === "claude") return "claude-code";
  if (source === "cursor") return "cursor";
  if (source === "antigravity") return "antigravity";
  return "codex";
}

function conversationItem(
  session: CanonicalSession,
  project: ProjectRegistration,
  sourceInfo: { size: number; mtime: string },
  buildRemoteImportItem: (
    source: ChatCrystalSource,
    meta: Record<string, unknown>,
    parsed: Record<string, unknown>,
    parserVersion: string,
  ) => unknown,
): unknown | null {
  if (session.messages.length < 2) return null;
  const source = mappedSource(session.source);
  const nativeId = `${project.id}:${session.source}:${session.nativeId}`;
  const parsedMessages = session.messages.map((item) => ({
    id: item.id,
    parentUuid: item.parentId ?? null,
    type:
      item.role === "user"
        ? "user"
        : item.role === "assistant"
          ? "assistant"
          : "system",
    role: item.role,
    content: item.content,
    hasToolUse: item.kind === "tool-call" || item.kind === "tool-result",
    hasCode: item.content.includes("```"),
    thinking: null,
    timestamp: item.timestamp,
  }));
  const parsed = {
    id: nativeId,
    slug: session.messages.find((item) => item.role === "user")?.content.slice(0, 100) ?? null,
    source,
    projectDir: project.rootPath,
    projectName: basename(project.rootPath),
    cwd: session.cwd,
    gitBranch: null,
    messages: parsedMessages,
    firstMessageAt: session.startedAt,
    lastMessageAt: session.endedAt,
  };
  const meta = {
    id: nativeId,
    source,
    filePath: session.sourcePath,
    fileSize: sourceInfo.size,
    fileMtime: sourceInfo.mtime,
    projectDir: project.rootPath,
  };
  return buildRemoteImportItem(source, meta, parsed, `camp-${session.source}@1`);
}

export async function syncChatCrystal(
  store: CampStore,
  project: ProjectRegistration,
): Promise<ChatCrystalResult> {
  const dataDir = join(store.paths.backendDir, "chatcrystal");
  ensurePrivateDirectory(dataDir);
  process.env.DATA_DIR = dataDir;

  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("chatcrystal/package.json"));
  const payloadModule = (await import(
    pathToFileURL(join(packageRoot, "dist", "server", "src", "services", "importPayload.js")).href
  )) as {
    SUPPORTED_IMPORT_SOURCES: string[];
    buildRemoteImportItem: (
      source: ChatCrystalSource,
      meta: Record<string, unknown>,
      parsed: Record<string, unknown>,
      parserVersion: string,
    ) => unknown;
  };
  if (!payloadModule.SUPPORTED_IMPORT_SOURCES.includes("antigravity")) {
    // Pinned ChatCrystal 0.5.8 exposes this mutable runtime enum. CAMP extends
    // it narrowly before normalized ingest; no native ChatCrystal watcher is
    // enabled and CAMP's canonical source remains authoritative.
    payloadModule.SUPPORTED_IMPORT_SOURCES.push("antigravity");
  }
  const ingestModule = (await import(
    pathToFileURL(join(packageRoot, "dist", "server", "src", "services", "ingest.js")).href
  )) as {
    ingestRemoteImport: (request: { version: 1; items: unknown[] }) => ChatCrystalResult;
  };
  const databaseModule = (await import(
    pathToFileURL(join(packageRoot, "dist", "server", "src", "db", "index.js")).href
  )) as { initDatabase: () => Promise<unknown> };

  // ChatCrystal logs database initialization to stdout. CAMP's MCP transport
  // and --json CLI output both require stdout to remain protocol-clean.
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await databaseModule.initDatabase();
  } finally {
    console.log = originalLog;
  }

  const items: unknown[] = [];
  for (const id of store.listSessionIds(project.id)) {
    const session = store.getSession(id, project.id);
    if (!session) continue;
    const item = conversationItem(
      session,
      project,
      store.sourceFileInfo(session.sourcePath),
      payloadModule.buildRemoteImportItem,
    );
    if (item) items.push(item);
  }
  if (!items.length) {
    ensurePrivateFile(join(dataDir, "chatcrystal.db"));
    return { total: 0, imported: 0, replaced: 0, skipped: 0, errors: 0, errorIds: [] };
  }
  const result = ingestModule.ingestRemoteImport({ version: 1, items });
  ensurePrivateFile(join(dataDir, "chatcrystal.db"));
  return result;
}

export async function purgeChatCrystalProject(
  store: CampStore,
  project: ProjectRegistration,
): Promise<{ deleted: number }> {
  const dataDir = join(store.paths.backendDir, "chatcrystal");
  ensurePrivateDirectory(dataDir);
  process.env.DATA_DIR = dataDir;
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("chatcrystal/package.json"));
  const databaseModule = (await import(
    pathToFileURL(join(packageRoot, "dist", "server", "src", "db", "index.js")).href
  )) as {
    initDatabase: () => Promise<unknown>;
    getDatabase: () => {
      run: (sql: string, params?: unknown[]) => void;
      getRowsModified: () => number;
    };
    saveDatabase: () => void;
  };
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await databaseModule.initDatabase();
  } finally {
    console.log = originalLog;
  }
  const db = databaseModule.getDatabase();
  db.run("DELETE FROM conversations WHERE source_conversation_id LIKE ?", [`${project.id}:%`]);
  const deleted = db.getRowsModified();
  databaseModule.saveDatabase();
  ensurePrivateFile(join(dataDir, "chatcrystal.db"));
  return { deleted };
}
