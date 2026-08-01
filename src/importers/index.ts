import type { ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
import { importAntigravity } from "./antigravity.js";
import { importClaude } from "./claude.js";
import { importCodex } from "./codex.js";
import { importCursor } from "./cursor.js";

export async function importProjectHistory(
  store: CampStore,
  project: ProjectRegistration,
  onSource?: (summary: ImportSummary) => void,
): Promise<ImportSummary[]> {
  const importers = [importCodex, importClaude, importCursor, importAntigravity];
  const summaries: ImportSummary[] = [];
  for (const importer of importers) {
    const summary = await importer(store, project);
    summaries.push(summary);
    onSource?.(summary);
  }
  return summaries;
}
