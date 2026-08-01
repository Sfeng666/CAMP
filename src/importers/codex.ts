import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { CanonicalMessage, ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { fileFingerprint, stableId, toStringContent } from "../utils.js";
import { userHome } from "../platform.js";
import {
  canonicalSession,
  message,
  projectMatch,
  readJsonLines,
  timestamp,
  walkFiles,
} from "./common.js";

interface ParsedCodex {
  nativeId: string;
  cwd: string | null;
  messages: CanonicalMessage[];
}

function extractCodexMessage(
  entry: Record<string, unknown>,
  sequence: number,
  sourceLine: number,
): CanonicalMessage | null {
  const payload = (entry.payload && typeof entry.payload === "object"
    ? entry.payload
    : entry) as Record<string, unknown>;
  const type = String(payload.type ?? entry.type ?? "");
  const at = entry.timestamp ?? payload.timestamp;

  if (type === "message") {
    const id = typeof payload.id === "string" ? payload.id : undefined;
    return message(sequence, {
      ...(id ? { id } : {}),
      role: payload.role,
      content: payload.content,
      timestamp: at,
      metadata: { sourceLine },
    });
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
    return message(sequence, {
      ...(id ? { id } : {}),
      role: "tool",
      kind: "tool-call",
      toolName: String(payload.name ?? "tool"),
      content: payload.arguments ?? payload.input ?? payload,
      timestamp: at,
      metadata: { sourceLine },
    });
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const id = typeof payload.call_id === "string" ? `${payload.call_id}:output` : undefined;
    return message(sequence, {
      ...(id ? { id } : {}),
      role: "tool",
      kind: "tool-result",
      content: payload.output ?? payload.content ?? payload,
      timestamp: at,
      metadata: { sourceLine },
    });
  }
  if (type === "user_message" || type === "agent_message") {
    return message(sequence, {
      role: type === "user_message" ? "user" : "assistant",
      content: payload.message ?? payload.text ?? payload.content,
      timestamp: at,
      metadata: { sourceLine },
    });
  }
  return null;
}

export async function parseCodexFile(path: string): Promise<ParsedCodex> {
  let nativeId = basename(path, ".jsonl");
  let cwd: string | null = null;
  const messages: CanonicalMessage[] = [];
  await readJsonLines(path, (entry, sourceLine) => {
    const payload = (entry.payload && typeof entry.payload === "object"
      ? entry.payload
      : {}) as Record<string, unknown>;
    if (entry.type === "session_meta") {
      if (typeof payload.id === "string") nativeId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      return;
    }
    if (entry.type === "turn_context" && typeof payload.cwd === "string") cwd = payload.cwd;
    if (entry.type !== "response_item" && entry.type !== "event_msg") return;
    const extracted = extractCodexMessage(entry, messages.length, sourceLine);
    if (extracted) messages.push(extracted);
  });
  return { nativeId, cwd, messages };
}

async function importCodexSummary(
  store: CampStore,
  project: ProjectRegistration,
  summary: ImportSummary,
): Promise<void> {
  const candidates = [
    resolve(project.rootPath, "codex_summary", "chat_history", "project_chat_history.jsonl"),
    resolve(project.rootPath, "codex_summary", "project_chat_history.jsonl"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    summary.scanned += 1;
    const grouped = new Map<string, CanonicalMessage[]>();
    await readJsonLines(path, (entry, line) => {
      const sessionId = String(
        entry.session_id ?? entry.sessionId ?? entry.conversation_id ?? "project-chat-archive",
      );
      const list = grouped.get(sessionId) ?? [];
      const item = message(list.length, {
        id: String(entry.id ?? line),
        role: entry.role,
        content: entry.content ?? entry.text ?? entry.message,
        timestamp: entry.timestamp ?? entry.created_at,
        metadata: {
          archive: true,
          sourceFile: entry.source_file,
          sourceLine: line,
        },
      });
      if (item) list.push(item);
      grouped.set(sessionId, list);
    });
    for (const [nativeId, messages] of grouped) {
      if (!messages.length) continue;
    const session = await canonicalSession({
      source: "archive",
      surface: "unknown",
        sourceVersion: "camp-codex-summary@1",
        nativeId,
        project,
        cwd: project.rootPath,
        sourcePath: path,
        messages,
        metadata: { source: "codex_summary" },
      });
      const result = store.storeSession(session);
      summary[result.status] += 1;
    }
  }
}

export async function importCodex(
  store: CampStore,
  project: ProjectRegistration,
  root = process.env.CODEX_SESSIONS_DIR ?? join(userHome(), ".codex", "sessions"),
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    source: "codex",
    scanned: 0,
    imported: 0,
    replaced: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
  };
  const files = await walkFiles(root, [".jsonl"], 6);
  for (const path of files) {
    summary.scanned += 1;
    try {
      const checkpointKey = stableId(path);
      const fingerprint = fileFingerprint(path);
      if (store.checkpoint(project.id, "codex", checkpointKey) === fingerprint) {
        summary.skipped += 1;
        continue;
      }
      const parsed = await parseCodexFile(path);
      const match = projectMatch(parsed.cwd, project);
      if (match === "unrelated") continue;
      const assigned = store.isSourceAssigned(
        "codex",
        path,
        parsed.nativeId,
        project.id,
      );
      if (match !== "exact" && !assigned) {
        if (match === "parent" && parsed.messages.length) {
          store.addQuarantine({
            projectId: project.id,
            source: "codex",
            sourcePath: path,
            nativeId: parsed.nativeId,
            reason: "Codex session is attached to a parent workspace; explicit project assignment is required",
            metadata: { cwd: parsed.cwd, messages: parsed.messages.length },
          });
          summary.quarantined += 1;
        }
        continue;
      }
      if (!parsed.messages.length) continue;
    const session = await canonicalSession({
      source: "codex",
      surface: "cli",
        sourceVersion: "codex-jsonl@1",
        nativeId: parsed.nativeId,
        project,
        cwd: parsed.cwd,
        sourcePath: path,
        messages: parsed.messages,
      });
      const result = store.storeSession(session);
      summary[result.status] += 1;
      store.setCheckpoint(project.id, "codex", checkpointKey, fingerprint);
    } catch (error) {
      summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await importCodexSummary(store, project, summary);
  return summary;
}
