import type { EvidenceRecord, ImportSummary, ProjectRegistration } from "./types.js";
import type { CampStore } from "./store.js";
import { importProjectHistory } from "./importers/index.js";
import { syncChatCrystal } from "./backends/chatcrystal.js";
import { finalizeMemorixMigration, flushMemorix, prepareMemorixMigration } from "./backends/memorix.js";
import { queueMemorix } from "./backends/memorix.js";
import { changedPaths } from "./git.js";
import { redactForRecall } from "./redaction.js";
import { truncateByApproxTokens } from "./utils.js";
import { syncSemanticIndex } from "./semantic.js";
import { summarizeSessionLocally } from "./summarization.js";
import { readProjectHandoff } from "./project-handoff.js";

export interface SyncResult {
  projectId: string;
  imports: ImportSummary[];
  chatcrystal: {
    total: number;
    imported: number;
    replaced: number;
    skipped: number;
    errors: number;
    errorIds: string[];
  } | null;
  memorix: ReturnType<typeof flushMemorix>;
  automaticHandoff: EvidenceRecord | null;
  semantic: Awaited<ReturnType<typeof syncSemanticIndex>>;
  errors: string[];
}

export async function createAutomaticHandoff(
  store: CampStore,
  project: ProjectRegistration,
): Promise<EvidenceRecord | null> {
  const latest = store.latestSession(project.id);
  if (!latest || latest.session.messages.length < 2) return null;
  const prior = store.latestHandoffPayload(project.id);
  if (prior?.sourceSessions.includes(latest.id)) return null;
  const projectDocument = !prior?.sourceSessions.length
    ? readProjectHandoff(project.rootPath)
    : null;
  if (projectDocument) {
    const record = store.createHandoff(project, {
      ...projectDocument.handoff,
      changedPaths: changedPaths(project.rootPath),
      sourceSessions: [latest.id],
    });
    queueMemorix(store, project, record);
    return record;
  }
  const substantiveUser = latest.session.messages
    .filter(
      (message) =>
        message.role === "user" &&
        !/^\s*<(?:recommended_plugins|environment_context|permissions instructions|skills_instructions)[>\s]/i.test(
          message.content,
        ),
    )
    .at(-1);
  if (!substantiveUser) return null;
  const goal = truncateByApproxTokens(redactForRecall(substantiveUser.content), 120)
    .replace(/\s+/g, " ")
    .trim();
  if (!goal) return null;
  const validationLines = latest.session.messages
    .filter((message) => message.kind === "tool-result")
    .flatMap((message) => redactForRecall(message.content).split(/\r?\n/))
    .filter((line) => /\b(?:test|typecheck|build|lint)\b.*\b(?:pass(?:ed)?|fail(?:ed)?|exit(?:ed)?\s+\d+)\b/i.test(line))
    .slice(0, 5)
    .map((line) => truncateByApproxTokens(line.trim(), 80));
  const localSummary = await summarizeSessionLocally(latest.session);
  try {
    const record = store.createHandoff(project, {
      goal: localSummary?.goal ?? goal,
      completed: localSummary?.completed.length
        ? localSummary.completed
        : [
            `Archived a substantive ${latest.session.source} session with ${latest.session.messages.length} ordered events.`,
          ],
      changedPaths: changedPaths(project.rootPath),
      validations: localSummary?.validations.length ? localSummary.validations : validationLines,
      unresolved: localSummary?.unresolved.length
        ? localSummary.unresolved
        : changedPaths(project.rootPath).length
          ? ["The current worktree is dirty; inspect its diff and revalidate historical results before editing."]
          : [],
      nextSteps: localSummary?.nextSteps.length
        ? localSummary.nextSteps
        : ["Inspect current files and revalidate historical status or test results before continuing."],
      sourceSessions: [latest.id],
    });
    queueMemorix(store, project, record);
    return record;
  } catch (error) {
    // Privacy admission can intentionally reject a user-facing task. The exact
    // session remains available in raw history without becoming auto-memory.
    if (error instanceof Error && /excluded from automatic curated memory/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function syncProject(
  store: CampStore,
  project: ProjectRegistration,
  onSource?: (summary: ImportSummary) => void,
): Promise<SyncResult> {
  const errors: string[] = [];
  store.refreshStaleness(project.id);
  const imports = await importProjectHistory(store, project, onSource);
  for (const summary of imports) {
    store.recordHealth(
      project.id,
      `source:${summary.source}`,
      summary.errors.length ? "degraded" : "ok",
      summary.errors.length
        ? summary.errors.join("; ")
        : `scanned=${summary.scanned} imported=${summary.imported} skipped=${summary.skipped} quarantined=${summary.quarantined}`,
    );
  }
  let chatcrystal: SyncResult["chatcrystal"] = null;
  try {
    const result = await syncChatCrystal(store, project);
    // ChatCrystal's pinned ingest response also carries one entry per session.
    // Keep CAMP's public status bounded even for large historical archives.
    chatcrystal = {
      total: result.total,
      imported: result.imported,
      replaced: result.replaced,
      skipped: result.skipped,
      errors: result.errors,
      errorIds: result.errorIds,
    };
    store.recordHealth(
      project.id,
      "backend:chatcrystal",
      chatcrystal.errors ? "degraded" : "ok",
      `total=${chatcrystal.total} errors=${chatcrystal.errors}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`ChatCrystal: ${detail}`);
    store.recordHealth(project.id, "backend:chatcrystal", "degraded", detail);
  }
  let automaticHandoff: EvidenceRecord | null = null;
  try {
    automaticHandoff = await createAutomaticHandoff(store, project);
  } catch (error) {
    errors.push(`Handoff: ${error instanceof Error ? error.message : String(error)}`);
  }
  prepareMemorixMigration(store, project);
  const memorix = flushMemorix(store, project);
  store.recordHealth(
    project.id,
    "backend:memorix",
    memorix.failed || memorix.unavailable ? "degraded" : "ok",
    memorix.unavailable
      ? "unavailable; curated writes remain queued"
      : `completed=${memorix.completed} failed=${memorix.failed}`,
  );
  finalizeMemorixMigration(store, project);
  const semantic = await syncSemanticIndex(store, project);
  store.recordHealth(
    project.id,
    "semantic:ollama",
    semantic.degraded ? "degraded" : "ok",
    semantic.degraded
      ? "local embeddings unavailable or awaiting explicit reindex; lexical FTS active"
      : `indexed=${semantic.indexed} pending=${semantic.pending}`,
  );
  errors.push(...memorix.errors.map((error) => `Memorix: ${error}`));
  return { projectId: project.id, imports, chatcrystal, memorix, automaticHandoff, semantic, errors };
}
