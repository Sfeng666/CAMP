import { opendir, readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentSource,
  AgentSurface,
  CanonicalMessage,
  CanonicalSession,
  ProjectRegistration,
} from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { fileFingerprint, isInsidePath, nowIso, sha256, stableId, toStringContent } from "../utils.js";

export type ProjectMatch = "exact" | "parent" | "unrelated" | "unknown";

export async function walkFiles(root: string, extensions: string[], maxDepth = 8): Promise<string[]> {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return;
    }
    for await (const entry of handle) {
      // Antigravity's documented transcript is nested in
      // `.system_generated/logs/transcript.jsonl`; keep all other hidden
      // directories excluded to avoid broad, accidental history scans.
      if (
        entry.name.startsWith(".") &&
        entry.name !== ".jsonl" &&
        entry.name !== ".system_generated"
      ) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) result.push(path);
    }
  }
  await visit(root, 0);
  return result.sort();
}

export async function readJsonLines(
  path: string,
  handler: (value: Record<string, unknown>, line: number) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  for await (const text of reader) {
    line += 1;
    if (!text.trim()) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        handler(value as Record<string, unknown>, line);
      }
    } catch {
      // A partially written final line is retried during the next sync.
    }
  }
}

export function projectMatch(cwd: string | null | undefined, project: ProjectRegistration): ProjectMatch {
  if (!cwd) return "unknown";
  try {
    const candidate = resolve(cwd);
    const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
    if (isInsidePath(resolved, project.rootPath)) return "exact";
    if (isInsidePath(project.rootPath, resolved)) return "parent";
    return "unrelated";
  } catch {
    return "unknown";
  }
}

export function timestamp(value: unknown, fallback = nowIso()): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) return timestamp(numeric, fallback);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

export function normalizeRole(value: unknown): CanonicalMessage["role"] {
  const role = String(value ?? "").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent" || role === "ai") return "assistant";
  if (role === "system" || role === "developer") return "system";
  if (role === "tool" || role === "function") return "tool";
  return "unknown";
}

export function message(
  sequence: number,
  input: {
    id?: string;
    role?: unknown;
    kind?: CanonicalMessage["kind"];
    content: unknown;
    timestamp?: unknown;
    toolName?: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
  },
): CanonicalMessage | null {
  const content = toStringContent(input.content).trim();
  if (!content) return null;
  return {
    id: input.id ?? stableId(sequence, content.slice(0, 256)),
    sequence,
    role: normalizeRole(input.role),
    kind: input.kind ?? "message",
    content,
    timestamp: timestamp(input.timestamp),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function dedupeMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const output: CanonicalMessage[] = [];
  for (const item of messages.sort((a, b) => a.sequence - b.sequence)) {
    if (seenIds.has(item.id)) continue;
    const key = sha256(`${item.role}\n${item.kind}\n${item.content}\n${item.timestamp}`);
    if (seenContent.has(key)) continue;
    seenIds.add(item.id);
    seenContent.add(key);
    output.push({ ...item, sequence: output.length });
  }
  return output;
}

export async function canonicalSession(input: {
  source: AgentSource;
  surface?: AgentSurface;
  sourceVersion?: string;
  nativeId: string;
  project: ProjectRegistration;
  cwd: string | null;
  sourcePath: string;
  messages: CanonicalMessage[];
  attachments?: CanonicalSession["attachments"];
  metadata?: Record<string, unknown>;
}): Promise<CanonicalSession> {
  const messages = dedupeMessages(input.messages);
  const sourceStat = await stat(input.sourcePath).catch(() => null);
  const fallback = sourceStat?.mtime.toISOString() ?? nowIso();
  const lastMetadata = messages.at(-1)?.metadata;
  const sourceOffset =
    typeof lastMetadata?.sourceLine === "number" || typeof lastMetadata?.sourceLine === "string"
      ? lastMetadata.sourceLine
      : typeof lastMetadata?.sourceKey === "string"
        ? lastMetadata.sourceKey
        : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: input.source,
    surface: input.surface ?? "unknown",
    ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    nativeId: input.nativeId,
    projectId: input.project.id,
    projectRoot: input.project.rootPath,
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    sourceFingerprint: sourceStat ? fileFingerprint(input.sourcePath) : sha256(input.sourcePath),
    startedAt: messages[0]?.timestamp ?? fallback,
    endedAt: messages.at(-1)?.timestamp ?? fallback,
    messages,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ingestionCheckpoint: { sourceOffset, importedAt: nowIso() },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
