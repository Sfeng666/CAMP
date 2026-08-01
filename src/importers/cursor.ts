import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalMessage, ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { cursorUserDataDirectory, userHome } from "../platform.js";
import { fileFingerprint, isInsidePath, sha256, stableId, toStringContent } from "../utils.js";
import { canonicalSession, message, readJsonLines, timestamp, walkFiles } from "./common.js";

interface ComposerHead {
  composerId: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  name?: string;
  projectMatch?: "confident" | "ambiguous";
  otherProjectPaths?: string[];
  storageVersion?: "workspace-composer-data" | "global-composer-headers";
}

interface WorkspaceInfo {
  folder: string;
  database: string;
  composers: ComposerHead[];
}

function openReadonly(path: string): InstanceType<typeof Database> {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("case_sensitive_like = ON");
  return db;
}

function decodeFolder(value: string): string {
  let decoded: string;
  try {
    decoded = value.startsWith("file://") ? fileURLToPath(value) : decodeURIComponent(value.replace(/^file:\/\/\//, "/"));
  } catch {
    decoded = decodeURIComponent(value.replace(/^file:\/\/\//, "/"));
  }
  try {
    return realpathSync(decoded);
  } catch {
    return resolve(decoded);
  }
}

function scanWorkspaces(userDir: string): WorkspaceInfo[] {
  const storage = join(userDir, "workspaceStorage");
  if (!existsSync(storage)) return [];
  const result: WorkspaceInfo[] = [];
  for (const entry of readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(storage, entry.name);
    const workspaceJson = join(directory, "workspace.json");
    const database = join(directory, "state.vscdb");
    if (!existsSync(workspaceJson) || !existsSync(database)) continue;
    try {
      const workspace = JSON.parse(readFileSync(workspaceJson, "utf8")) as { folder?: string };
      if (!workspace.folder) continue;
      const db = openReadonly(database);
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE [key] = 'composer.composerData'")
          .get() as { value: string } | undefined;
        if (!row) continue;
        const parsed = JSON.parse(row.value) as { allComposers?: ComposerHead[] };
        if (!parsed.allComposers?.length) continue;
        result.push({
          folder: decodeFolder(workspace.folder),
          database,
          composers: parsed.allComposers.map((composer) => ({
            ...composer,
            storageVersion: "workspace-composer-data",
          })),
        });
      } finally {
        db.close();
      }
    } catch {
      // A corrupt/locked workspace is reported only when it maps to a project.
    }
  }
  return result;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/**
 * Cursor 1.7+ moved composer heads from per-workspace ItemTable rows into a
 * compact global composerHeaders table. Query only headers containing the
 * exact registered path, then stream only those composers' bubble keys.
 */
function scanGlobalComposerHeaders(
  db: InstanceType<typeof Database>,
  globalDatabase: string,
  project: ProjectRegistration,
): WorkspaceInfo[] {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
    .get();
  if (!table) return [];
  const columns = new Set(
    (db.prepare("PRAGMA table_info(composerHeaders)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!["composerId", "workspaceId", "value"].every((column) => columns.has(column))) {
    return [];
  }

  const roots = new Set([project.rootPath, ...project.activePaths].map(canonicalPath));
  const encodedRoot = encodeURI(project.rootPath);
  const rows = db
    .prepare(`
      SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
      FROM composerHeaders
      WHERE instr(value, ?) > 0 OR instr(value, ?) > 0
      ORDER BY lastUpdatedAt, composerId
    `)
    .all(project.rootPath, encodedRoot) as Array<{
      composerId: string;
      workspaceId: string | null;
      createdAt: number | null;
      lastUpdatedAt: number | null;
      value: string;
    }>;

  const workspaces: WorkspaceInfo[] = [];
  for (const row of rows) {
    try {
      const head = JSON.parse(row.value) as Record<string, unknown>;
      if (head.type !== undefined && head.type !== "head") continue;
      const tracked = Array.isArray(head.trackedGitRepos)
        ? head.trackedGitRepos
            .map((item) => objectRecord(item).repoPath)
            .filter((path): path is string => typeof path === "string")
            .map(canonicalPath)
        : [];
      const matching = tracked.filter((path) => roots.has(path));
      const otherProjectPaths = [...new Set(tracked.filter((path) => !roots.has(path)))];
      const workspaceIdentifier = objectRecord(head.workspaceIdentifier);
      const workspaceUri = objectRecord(workspaceIdentifier.uri);
      const rawWorkspace =
        typeof workspaceUri.fsPath === "string"
          ? workspaceUri.fsPath
          : typeof workspaceUri.path === "string"
            ? workspaceUri.path
            : project.rootPath;

      // A header with an exact tracked repository and no siblings is strong
      // evidence. Multi-repository parent-workspace composers require review.
      // If old headers lack trackedGitRepos, the exact path match remains
      // usable but bubble-level evidence is still required below.
      const projectMatch = matching.length
        ? otherProjectPaths.length
          ? "ambiguous"
          : "confident"
        : undefined;
      workspaces.push({
        folder: decodeFolder(rawWorkspace),
        database: globalDatabase,
        composers: [
          {
            composerId: row.composerId,
            ...(row.createdAt !== null ? { createdAt: row.createdAt } : {}),
            ...(row.lastUpdatedAt !== null ? { lastUpdatedAt: row.lastUpdatedAt } : {}),
            ...(typeof head.name === "string" ? { name: head.name } : {}),
            ...(projectMatch ? { projectMatch } : {}),
            ...(otherProjectPaths.length ? { otherProjectPaths } : {}),
            storageVersion: "global-composer-headers",
          },
        ],
      });
    } catch {
      // Malformed header rows are ignored here; no transcript is guessed.
    }
  }
  return workspaces;
}

function bubbleMessages(
  rows: Iterable<{ key: string; value: string }>,
  projectRoot: string,
): {
  messages: CanonicalMessage[];
  directProjectEvidence: boolean;
  unknownSchemas: number[];
  sourceHash: string;
  attachments: Array<{
    hash: string;
    mediaType: string | null;
    size: number | null;
    sourceUri: string;
  }>;
} {
  const messages: CanonicalMessage[] = [];
  let directProjectEvidence = false;
  const unknownSchemas = new Set<number>();
  const sourceHash = createHash("sha256");
  const attachments = new Map<string, {
    hash: string;
    mediaType: string | null;
    size: number | null;
    sourceUri: string;
  }>();
  for (const row of rows) {
    sourceHash.update(row.key).update("\0").update(row.value).update("\0");
    let bubble: Record<string, unknown>;
    try {
      bubble = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.value.includes(projectRoot) || row.value.includes(encodeURI(projectRoot))) {
      directProjectEvidence = true;
    }
    if (typeof bubble._v === "number" && bubble._v > 3) unknownSchemas.add(bubble._v);
    const bubbleId = String(bubble.bubbleId ?? row.key.split(":").at(-1) ?? messages.length);
    const rawAttachments = [bubble.attachments, bubble.fileAttachments, bubble.images]
      .filter(Array.isArray)
      .flat() as unknown[];
    for (const [attachmentIndex, rawAttachment] of rawAttachments.entries()) {
      const attachment =
        rawAttachment && typeof rawAttachment === "object"
          ? (rawAttachment as Record<string, unknown>)
          : {};
      const data =
        typeof attachment.data === "string"
          ? attachment.data
          : typeof attachment.base64 === "string"
            ? attachment.base64
            : typeof attachment.content === "string"
              ? attachment.content
              : null;
      const suppliedHash =
        typeof attachment.sha256 === "string"
          ? attachment.sha256
          : typeof attachment.hash === "string" && /^[a-f0-9]{32,}$/i.test(attachment.hash)
            ? attachment.hash
            : null;
      const hash = suppliedHash ?? (data ? sha256(data) : null);
      if (!hash) continue;
      const sourceUri = String(
        attachment.uri ??
          attachment.path ??
          attachment.id ??
          `cursor://${bubbleId}/attachment/${attachmentIndex}`,
      );
      attachments.set(hash, {
        hash,
        mediaType:
          typeof attachment.mimeType === "string"
            ? attachment.mimeType
            : typeof attachment.mediaType === "string"
              ? attachment.mediaType
              : null,
        size:
          typeof attachment.size === "number"
            ? attachment.size
            : data
              ? Buffer.byteLength(data)
              : null,
        sourceUri,
      });
    }
    const role = bubble.type === 1 ? "user" : "assistant";
    const item = message(messages.length, {
      id: bubbleId,
      role,
      content: bubble.text ?? "",
      timestamp: bubble.createdAt,
      metadata: {
        schemaVersion: bubble._v ?? null,
        agentic: bubble.isAgentic === true,
        thinking: bubble.allThinkingBlocks ?? bubble.thinking ?? null,
        sourceKey: row.key,
      },
    });
    if (item) messages.push(item);

    const toolResults = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
    for (const [index, toolResult] of toolResults.entries()) {
      const tool = toolResult && typeof toolResult === "object"
        ? (toolResult as Record<string, unknown>)
        : {};
      const toolMessage = message(messages.length, {
        id: `${bubbleId}:tool:${index}`,
        role: "tool",
        kind: "tool-result",
        toolName: String(tool.toolName ?? tool.name ?? "cursor-tool"),
        content: tool.result ?? tool.output ?? tool.content ?? toolResult,
        timestamp: bubble.createdAt,
      });
      if (toolMessage) messages.push(toolMessage);
    }
  }
  messages.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence,
  );
  messages.forEach((item, sequence) => {
    item.sequence = sequence;
  });
  return {
    messages,
    directProjectEvidence,
    unknownSchemas: [...unknownSchemas],
    sourceHash: sourceHash.digest("hex"),
    attachments: [...attachments.values()],
  };
}

function cursorProjectDirectoryKeys(rootPath: string): Set<string> {
  const canonical = canonicalPath(rootPath);
  const flattened = canonical.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return new Set([
    flattened,
    encodeURIComponent(canonical),
    encodeURI(canonical),
    canonical.replaceAll("/", "-"),
  ]);
}

function cursorCliContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.content ?? record.text ?? record.message ?? record.parts ?? value;
}

/**
 * Cursor Agent CLI writes a compact JSONL transcript under its project root.
 * The transcript currently omits timestamps in some versions, so the archive
 * preserves source order and uses only the file mtime as a deterministic
 * session fallback. A project directory must exactly encode the registered
 * root before it is imported automatically.
 */
async function importCursorCli(
  store: CampStore,
  project: ProjectRegistration,
  summary: ImportSummary,
  projectsRoot = process.env.CURSOR_PROJECTS_DIR ?? join(userHome(), ".cursor", "projects"),
): Promise<void> {
  if (!existsSync(projectsRoot)) return;
  const keys = cursorProjectDirectoryKeys(project.rootPath);
  let directories: string[] = [];
  try {
    directories = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && keys.has(entry.name))
      .map((entry) => join(projectsRoot, entry.name));
  } catch (error) {
    summary.errors.push(`Cursor CLI projects: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const directory of directories) {
    const transcripts = await walkFiles(join(directory, "agent-transcripts"), [".jsonl"], 4);
    for (const path of transcripts) {
      summary.scanned += 1;
      const nativeId = `cursor-cli:${basename(path, ".jsonl")}`;
      const fingerprint = fileFingerprint(path);
      const checkpointKey = stableId(path, nativeId);
      if (store.checkpoint(project.id, "cursor", checkpointKey) === fingerprint) {
        summary.skipped += 1;
        continue;
      }
      const messages: CanonicalMessage[] = [];
      await readJsonLines(path, (entry, sourceLine) => {
        const rawMessage = entry.message ?? entry.payload ?? entry.content;
        const item = message(messages.length, {
          id: typeof entry.id === "string" ? entry.id : `${nativeId}:${sourceLine}`,
          role: entry.role ?? entry.type,
          content: cursorCliContent(rawMessage),
          timestamp: entry.timestamp ?? entry.createdAt ?? entry.time,
          metadata: { sourceLine, transcriptFormat: "cursor-agent-jsonl@1" },
        });
        if (item) messages.push(item);
      });
      if (!messages.length) {
        summary.errors.push(`Cursor CLI transcript contained no supported messages: ${path}`);
        continue;
      }
      const session = await canonicalSession({
        source: "cursor",
        surface: "cli",
        sourceVersion: "cursor-agent-transcript@1",
        nativeId,
        project,
        cwd: project.rootPath,
        sourcePath: path,
        messages,
        metadata: { projectDirectory: directory, projectEvidence: "exact-project-directory" },
      });
      const result = store.storeSession(session);
      summary[result.status] += 1;
      store.setCheckpoint(project.id, "cursor", checkpointKey, fingerprint);
    }
  }
}

export async function importCursor(
  store: CampStore,
  project: ProjectRegistration,
  userDir = cursorUserDataDirectory(),
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    source: "cursor",
    scanned: 0,
    imported: 0,
    replaced: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
  };
  await importCursorCli(store, project, summary);

  const globalDatabase = join(userDir, "globalStorage", "state.vscdb");
  if (!existsSync(globalDatabase)) return summary;

  let db: InstanceType<typeof Database>;
  try {
    db = openReadonly(globalDatabase);
  } catch (error) {
    summary.errors.push(`Cursor database: ${error instanceof Error ? error.message : String(error)}`);
    return summary;
  }
  try {
    const legacyWorkspaces = scanWorkspaces(userDir).filter(
      (workspace) =>
        isInsidePath(workspace.folder, project.rootPath) ||
        isInsidePath(project.rootPath, workspace.folder),
    );
    const modernWorkspaces = scanGlobalComposerHeaders(db, globalDatabase, project);
    const seenComposers = new Set<string>();
    const workspaces = [...modernWorkspaces, ...legacyWorkspaces]
      .map((workspace) => ({
        ...workspace,
        composers: workspace.composers.filter((composer) => {
          if (seenComposers.has(composer.composerId)) return false;
          seenComposers.add(composer.composerId);
          return true;
        }),
      }))
      .filter((workspace) => workspace.composers.length);
    if (!workspaces.length) return summary;
    const query = db.prepare(
      "SELECT [key] AS key, value FROM cursorDiskKV WHERE [key] LIKE ? ORDER BY [key]",
    );
    for (const workspace of workspaces) {
      const exactWorkspace = isInsidePath(workspace.folder, project.rootPath);
      for (const composer of workspace.composers) {
        summary.scanned += 1;
        try {
          const rows = query.iterate(`bubbleId:${composer.composerId}:%`) as Iterable<{
            key: string;
            value: string;
          }>;
          const parsed = bubbleMessages(rows, project.rootPath);
          if (!parsed.messages.length) continue;
          const assigned = store.isSourceAssigned(
            "cursor",
            globalDatabase,
            composer.composerId,
            project.id,
          );
          if (composer.projectMatch === "ambiguous" && !assigned) {
            store.addQuarantine({
              projectId: project.id,
              source: "cursor",
              sourcePath: globalDatabase,
              nativeId: composer.composerId,
              reason: "Cursor composer spans sibling Git repositories in a parent workspace; explicit project assignment is required",
              metadata: {
                workspace: workspace.folder,
                name: composer.name ?? null,
                otherProjectPaths: composer.otherProjectPaths ?? [],
                messages: parsed.messages.length,
              },
            });
            summary.quarantined += 1;
            continue;
          }
          if (
            !exactWorkspace &&
            composer.projectMatch !== "confident" &&
            !parsed.directProjectEvidence &&
            !assigned
          ) {
            store.addQuarantine({
              projectId: project.id,
              source: "cursor",
              sourcePath: globalDatabase,
              nativeId: composer.composerId,
              reason: "Cursor conversation belongs to a parent workspace and contains no exclusive project-path evidence",
              metadata: {
                workspace: workspace.folder,
                name: composer.name ?? null,
                messages: parsed.messages.length,
              },
            });
            summary.quarantined += 1;
            continue;
          }
          if (parsed.unknownSchemas.length) {
            store.addQuarantine({
              projectId: project.id,
              source: "cursor",
              sourcePath: globalDatabase,
              nativeId: composer.composerId,
              reason: `Unknown Cursor bubble schema: ${parsed.unknownSchemas.join(", ")}`,
              metadata: { workspace: workspace.folder },
            });
            summary.quarantined += 1;
            continue;
          }
          const checkpointKey = stableId(globalDatabase, composer.composerId);
          if (store.checkpoint(project.id, "cursor", checkpointKey) === parsed.sourceHash) {
            summary.skipped += 1;
            continue;
          }
          const session = await canonicalSession({
            source: "cursor",
            surface: "ide",
            sourceVersion:
              composer.storageVersion === "global-composer-headers"
                ? "cursor-vscdb@2"
                : "cursor-vscdb@1",
            nativeId: composer.composerId,
            project,
            cwd: workspace.folder,
            sourcePath: globalDatabase,
            messages: parsed.messages,
            attachments: parsed.attachments,
            metadata: {
              workspaceDatabase: workspace.database,
              composerName: composer.name ?? null,
              storageVersion: composer.storageVersion ?? "workspace-composer-data",
            },
          });
          const result = store.storeSession(session);
          summary[result.status] += 1;
          store.setCheckpoint(project.id, "cursor", checkpointKey, parsed.sourceHash);
        } catch (error) {
          summary.errors.push(
            `${composer.composerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } finally {
    db.close();
  }
  return summary;
}
