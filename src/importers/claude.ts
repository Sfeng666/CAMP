import { basename, join } from "node:path";
import type { CanonicalMessage, ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { fileFingerprint, stableId } from "../utils.js";
import { userHome } from "../platform.js";
import { canonicalSession, message, projectMatch, readJsonLines, walkFiles } from "./common.js";

export async function importClaude(
  store: CampStore,
  project: ProjectRegistration,
  root = process.env.CLAUDE_PROJECTS_DIR ?? join(userHome(), ".claude", "projects"),
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    source: "claude",
    scanned: 0,
    imported: 0,
    replaced: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
  };
  for (const path of await walkFiles(root, [".jsonl"], 5)) {
    summary.scanned += 1;
    try {
      const checkpointKey = stableId(path);
      const fingerprint = fileFingerprint(path);
      if (store.checkpoint(project.id, "claude", checkpointKey) === fingerprint) {
        summary.skipped += 1;
        continue;
      }
      let cwd: string | null = null;
      let nativeId = basename(path, ".jsonl");
      const messages: CanonicalMessage[] = [];
      await readJsonLines(path, (entry, sourceLine) => {
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.sessionId === "string") nativeId = entry.sessionId;
        const rawMessage = entry.message && typeof entry.message === "object"
          ? (entry.message as Record<string, unknown>)
          : entry;
        const type = String(entry.type ?? rawMessage.type ?? "");
        if (!new Set(["user", "assistant", "system", "message"]).has(type)) return;
        const id = typeof entry.uuid === "string" ? entry.uuid : undefined;
        const parentId = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
        const item = message(messages.length, {
          ...(id ? { id } : {}),
          ...(parentId ? { parentId } : {}),
          role: rawMessage.role ?? type,
          content: rawMessage.content ?? entry.content,
          timestamp: entry.timestamp ?? entry.createdAt,
          metadata: { sourceLine },
        });
        if (item) messages.push(item);
      });
      const match = projectMatch(cwd, project);
      if (match === "unrelated" || match === "unknown") continue;
      const assigned = store.isSourceAssigned("claude", path, nativeId, project.id);
      if (match === "parent" && !assigned) {
        store.addQuarantine({
          projectId: project.id,
          source: "claude",
          sourcePath: path,
          nativeId,
          reason: "Claude session is attached to a parent workspace; explicit project assignment is required",
          metadata: { cwd, messages: messages.length },
        });
        summary.quarantined += 1;
        continue;
      }
      if (!messages.length) continue;
    const session = await canonicalSession({
      source: "claude",
      surface: "cli",
        sourceVersion: "claude-jsonl@1",
        nativeId,
        project,
        cwd,
        sourcePath: path,
        messages,
      });
      const result = store.storeSession(session);
      summary[result.status] += 1;
      store.setCheckpoint(project.id, "claude", checkpointKey, fingerprint);
    } catch (error) {
      summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
